/**
 * Unified audio router for VoiceBridge Desktop.
 * Replaces AudioCaptureModule + AudioOutputModule + AudioBridge
 * with a single module coordinating real mic capture, pipeline routing,
 * and virtual mic output via the native addon.
 */

import type { NativeAudioAddon } from '../native/native-addon.js';
import type { VADState, AudioRoutingState, AudioRoutingEvent } from '../shared/types.js';

// ── Constants ───────────────────────────────────────────────

const CHUNK_SIZE = 4000; // 250ms at 16kHz
const VAD_FRAME_SIZE = 160; // 10ms at 16kHz
const CALIBRATION_DURATION_MS = 5000;

// ── Pure Functions (reused from Chrome extension logic) ─────

/** Compute RMS energy in dB for an audio frame. */
export function computeRmsDb(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const normalized = (samples[i] ?? 0) / 32768;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/** Pure VAD state transition function. */
export function transitionVADState(
  current: VADState,
  energyDb: number,
  thresholdDb: number,
  now: number,
  onsetDelayMs: number,
  offsetDelayMs: number,
): VADState {
  const aboveThreshold = energyDb > thresholdDb;
  switch (current.status) {
    case 'silence':
      if (aboveThreshold) return { status: 'speech-pending', startedAt: now };
      return current;
    case 'speech-pending':
      if (!aboveThreshold) return { status: 'silence' };
      if (now - current.startedAt >= onsetDelayMs) return { status: 'speech' };
      return current;
    case 'speech':
      if (!aboveThreshold) return { status: 'silence-pending', startedAt: now };
      return current;
    case 'silence-pending':
      if (aboveThreshold) return { status: 'speech' };
      if (now - current.startedAt >= offsetDelayMs) return { status: 'silence' };
      return current;
  }
}

/** Pure audio routing state transition. */
export function transitionRoutingState(
  current: AudioRoutingState,
  event: AudioRoutingEvent,
): AudioRoutingState {
  switch (current) {
    case 'PASSTHROUGH':
      if (event.type === 'session_start') return 'MUTED';
      return current;
    case 'MUTED':
      if (event.type === 'tts_start') return 'TTS_PLAYING';
      if (event.type === 'session_stop') return 'PASSTHROUGH';
      if (event.type === 'degraded_to_passthrough') return 'PASSTHROUGH';
      return current;
    case 'TTS_PLAYING':
      if (event.type === 'tts_end') return 'MUTED';
      if (event.type === 'barge_in') return 'BARGE_IN';
      if (event.type === 'session_stop') return 'PASSTHROUGH';
      return current;
    case 'BARGE_IN':
      if (event.type === 'vad_speech_end') return 'MUTED';
      if (event.type === 'session_stop') return 'PASSTHROUGH';
      return current;
  }
}

/** Determine what audio source to use for the virtual mic. */
export function getAudioSource(
  state: AudioRoutingState,
): 'mic' | 'silence' | 'tts' | 'mic-fade-tts' {
  switch (state) {
    case 'PASSTHROUGH': return 'mic';
    case 'MUTED': return 'silence';
    case 'TTS_PLAYING': return 'tts';
    case 'BARGE_IN': return 'mic-fade-tts';
  }
}

/** Normalize TTS audio volume to match reference mic level. */
export function normalizeVolume(
  pcm: Int16Array,
  referenceRmsDb: number,
  targetRmsDb: number,
): Int16Array {
  if (referenceRmsDb <= -60 || targetRmsDb <= -60) return pcm;
  const gainDb = targetRmsDb - referenceRmsDb;
  const gainLinear = Math.pow(10, gainDb / 20);
  const output = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const scaled = (pcm[i] ?? 0) * gainLinear;
    output[i] = Math.max(-32768, Math.min(32767, Math.round(scaled)));
  }
  return output;
}

// ── Audio Router Configuration ──────────────────────────────

export interface AudioRouterConfig {
  captureDeviceId: string | null;
  captureSampleRate: 16000;
  outputSampleRate: 48000;
  noiseGateThresholdDb: number;
  vadSpeechOnsetMs: number;
  vadSpeechOffsetMs: number;
  ghostModeEnabled: boolean;
}

const DEFAULT_CONFIG: AudioRouterConfig = {
  captureDeviceId: null,
  captureSampleRate: 16000,
  outputSampleRate: 48000,
  noiseGateThresholdDb: -40,
  vadSpeechOnsetMs: 300,
  vadSpeechOffsetMs: 800,
  ghostModeEnabled: false,
};

// ── Audio Router ────────────────────────────────────────────

export class AudioRouter {
  #nativeAddon: NativeAudioAddon;
  #config: AudioRouterConfig;
  #buffer = new Int16Array(CHUNK_SIZE);
  #bufferOffset = 0;
  #sequenceId = 0;
  #vadState: VADState = { status: 'silence' };
  #routingState: AudioRoutingState = 'PASSTHROUGH';
  #running = false;
  #referenceLevel = -30;
  #calibrationSamples: number[] = [];
  #calibrationStartedAt = 0;

  // Callbacks
  onAudioChunk: ((chunk: Int16Array, sequenceId: number) => void) | null = null;
  onVADStateChange: ((state: VADState) => void) | null = null;
  onSpeechEnd: (() => void) | null = null;

  constructor(nativeAddon: NativeAudioAddon, config?: Partial<AudioRouterConfig>) {
    this.#nativeAddon = nativeAddon;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start audio capture and routing. */
  start(config?: Partial<AudioRouterConfig>): void {
    if (this.#running) return;
    if (config) Object.assign(this.#config, config);

    this.#running = true;
    this.#calibrationStartedAt = Date.now();
    this.#calibrationSamples = [];

    const deviceId = this.#config.captureDeviceId
      ?? this.#nativeAddon.getDefaultInputDevice()?.id
      ?? 'default';

    this.#nativeAddon.onAudioChunk = (pcm: Buffer, _seq: number) => {
      this.#processRawAudio(pcm);
    };

    this.#nativeAddon.startCapture(deviceId, {
      sampleRate: 16000,
      channels: 1,
      bufferSizeMs: 250,
      format: 'pcm_s16le',
    });
  }

  /** Stop audio capture and routing. */
  stop(): void {
    this.#running = false;
    this.#nativeAddon.stopCapture();
    this.#nativeAddon.onAudioChunk = null;
    this.#buffer = new Int16Array(CHUNK_SIZE);
    this.#bufferOffset = 0;
    this.#vadState = { status: 'silence' };
  }

  /** Enable/disable passthrough mode. */
  setPassthrough(enabled: boolean): void {
    if (enabled) {
      this.#routingState = 'PASSTHROUGH';
    } else {
      this.#routingState = 'MUTED';
    }
  }

  /** Change capture device without stopping. */
  setCaptureDevice(deviceId: string): void {
    this.#config.captureDeviceId = deviceId;
    if (this.#running) {
      this.#nativeAddon.stopCapture();
      this.#nativeAddon.startCapture(deviceId, {
        sampleRate: 16000,
        channels: 1,
        bufferSizeMs: 250,
        format: 'pcm_s16le',
      });
    }
  }

  /** Toggle Ghost Mode (lower threshold, higher gain). */
  setGhostMode(enabled: boolean): void {
    this.#config.ghostModeEnabled = enabled;
    this.#config.noiseGateThresholdDb = enabled ? -55 : -40;
    this.#nativeAddon.setCaptureGain(enabled ? 20 : 0);
  }

  /** Set noise gate threshold. */
  setNoiseGateThreshold(db: number): void {
    this.#config.noiseGateThresholdDb = db;
  }

  /** Get current input level in dB. */
  getInputLevel(): number {
    return computeRmsDb(this.#buffer.subarray(0, this.#bufferOffset));
  }

  /** Get calibrated average input level. */
  getAverageInputLevel(): number {
    return this.#referenceLevel;
  }

  /** Get current routing state. */
  getRoutingState(): AudioRoutingState {
    return this.#routingState;
  }

  /** Transition routing state. */
  transitionRouting(event: AudioRoutingEvent): void {
    const next = transitionRoutingState(this.#routingState, event);
    if (next !== this.#routingState) {
      this.#routingState = next;
    }
  }

  /** Write TTS audio to virtual mic (resampled to 48kHz). */
  writeTTSAudio(pcm: Buffer): void {
    const resampled = this.#nativeAddon.resample(pcm, 24000, 48000);
    this.#nativeAddon.writeVirtualMic(resampled);
  }

  /** Write silence to virtual mic. */
  writeSilence(): void {
    const silence = Buffer.alloc(48000 * 2 / 40, 0); // 25ms of silence at 48kHz
    this.#nativeAddon.writeVirtualMic(silence);
  }

  /** Write passthrough audio (real mic → virtual mic). */
  writePassthrough(pcm: Buffer): void {
    const resampled = this.#nativeAddon.resample(pcm, 16000, 48000);
    this.#nativeAddon.writeVirtualMic(resampled);
  }

  /** Fade out TTS audio over specified duration. */
  fadeOutTTS(durationMs: number): void {
    // Generate a fade-out ramp and write to virtual mic
    const samplesPerMs = 48;
    const totalSamples = samplesPerMs * durationMs;
    const fadeBuffer = Buffer.alloc(totalSamples * 2);
    for (let i = 0; i < totalSamples; i++) {
      const gain = 1 - (i / totalSamples);
      fadeBuffer.writeInt16LE(Math.round(gain * 0), i * 2); // Fade from current to silence
    }
    this.#nativeAddon.writeVirtualMic(fadeBuffer);
  }

  // ── Private Methods ─────────────────────────────────────────

  #processRawAudio(pcm: Buffer): void {
    if (!this.#running) return;

    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);

    // Calibrate reference level during first 5 seconds
    if (Date.now() - this.#calibrationStartedAt < CALIBRATION_DURATION_MS) {
      const rms = computeRmsDb(samples);
      if (rms > -60) this.#calibrationSamples.push(rms);
      if (this.#calibrationSamples.length > 0) {
        this.#referenceLevel = this.#calibrationSamples.reduce((a, b) => a + b, 0) / this.#calibrationSamples.length;
      }
    }

    // Run VAD on 10ms frames
    for (let i = 0; i < samples.length; i += VAD_FRAME_SIZE) {
      const end = Math.min(i + VAD_FRAME_SIZE, samples.length);
      const frame = samples.subarray(i, end);
      const energyDb = computeRmsDb(frame);
      const prevState = this.#vadState;

      this.#vadState = transitionVADState(
        this.#vadState,
        energyDb,
        this.#config.noiseGateThresholdDb,
        Date.now(),
        this.#config.vadSpeechOnsetMs,
        this.#config.vadSpeechOffsetMs,
      );

      if (this.#vadState.status !== prevState.status) {
        this.onVADStateChange?.(this.#vadState);
        if (prevState.status === 'silence-pending' && this.#vadState.status === 'silence') {
          this.onSpeechEnd?.();
        }
      }
    }

    // Noise gate: only buffer if above threshold
    const chunkEnergy = computeRmsDb(samples);
    if (chunkEnergy <= this.#config.noiseGateThresholdDb) {
      // In passthrough mode, still write silence to virtual mic
      if (this.#routingState === 'PASSTHROUGH') {
        this.writeSilence();
      }
      return;
    }

    // Route audio based on current state
    const source = getAudioSource(this.#routingState);
    if (source === 'mic' || source === 'mic-fade-tts') {
      this.writePassthrough(pcm);
    }

    // Accumulate into buffer, emit 250ms chunks for STT
    let offset = 0;
    while (offset < samples.length) {
      const remaining = CHUNK_SIZE - this.#bufferOffset;
      const toCopy = Math.min(remaining, samples.length - offset);
      this.#buffer.set(samples.subarray(offset, offset + toCopy), this.#bufferOffset);
      this.#bufferOffset += toCopy;
      offset += toCopy;

      if (this.#bufferOffset === CHUNK_SIZE) {
        this.#sequenceId++;
        this.onAudioChunk?.(this.#buffer, this.#sequenceId);
        this.#buffer = new Int16Array(CHUNK_SIZE);
        this.#bufferOffset = 0;
      }
    }
  }
}
