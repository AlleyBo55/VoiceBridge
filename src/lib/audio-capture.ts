/**
 * Microphone audio capture with AudioWorklet, VAD, noise gating, and chunking.
 * Runs in the offscreen document.
 */

import type { VADState } from './types.js';

// ── Constants ───────────────────────────────────────────────

const SAMPLE_RATE = 16000;
const CHUNK_SIZE = 4000; // 250ms at 16kHz
const VAD_FRAME_SIZE = 160; // 10ms at 16kHz

// ── Configuration ───────────────────────────────────────────

export interface AudioCaptureConfig {
  sampleRate: 16000;
  channelCount: 1;
  noiseGateThresholdDb: number;
  vadSpeechOnsetMs: number;
  vadSpeechOffsetMs: number;
  ghostModeGainDb: number;
}

const DEFAULT_CONFIG: AudioCaptureConfig = {
  sampleRate: SAMPLE_RATE,
  channelCount: 1,
  noiseGateThresholdDb: -40,
  vadSpeechOnsetMs: 300,
  vadSpeechOffsetMs: 800,
  ghostModeGainDb: 0,
};

// ── VAD ─────────────────────────────────────────────────────

/**
 * Compute RMS energy in dB for an audio frame.
 */
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

/**
 * Pure VAD state transition function.
 */
export function transitionVADState(
  current: VADState,
  energyDb: number,
  thresholdDb: number,
  now: number,
  onsetDelayMs: number,
  offsetDelayMs: number
): VADState {
  const aboveThreshold = energyDb > thresholdDb;

  switch (current.status) {
    case 'silence':
      if (aboveThreshold) {
        return { status: 'speech-pending', startedAt: now };
      }
      return current;

    case 'speech-pending':
      if (!aboveThreshold) {
        return { status: 'silence' };
      }
      if (now - current.startedAt >= onsetDelayMs) {
        return { status: 'speech' };
      }
      return current;

    case 'speech':
      if (!aboveThreshold) {
        return { status: 'silence-pending', startedAt: now };
      }
      return current;

    case 'silence-pending':
      if (aboveThreshold) {
        return { status: 'speech' };
      }
      if (now - current.startedAt >= offsetDelayMs) {
        return { status: 'silence' };
      }
      return current;
  }
}

// ── Audio Capture Module ────────────────────────────────────

export class AudioCaptureModule {
  #config: AudioCaptureConfig;
  #audioContext: AudioContext | null = null;
  #workletNode: AudioWorkletNode | null = null;
  #mediaStream: MediaStream | null = null;
  #buffer = new Int16Array(CHUNK_SIZE);
  #bufferOffset = 0;
  #sequenceId = 0;
  #muted = false;
  #vadState: VADState = { status: 'silence' };
  #ghostMode = false;
  #gainNode: GainNode | null = null;

  onAudioChunk: ((chunk: Int16Array, sequenceId: number) => void) | null = null;
  onVADStateChange: ((state: VADState) => void) | null = null;
  onSpeechEnd: (() => void) | null = null;

  constructor(config: Partial<AudioCaptureConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    this.#mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: SAMPLE_RATE,
      },
    });

    this.#audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = this.#audioContext.createMediaStreamSource(this.#mediaStream);

    // Gain node for Ghost Mode amplification
    this.#gainNode = this.#audioContext.createGain();
    this.#gainNode.gain.value = this.#ghostMode
      ? Math.pow(10, this.#config.ghostModeGainDb / 20)
      : 1;
    source.connect(this.#gainNode);

    // Load and connect AudioWorklet
    await this.#audioContext.audioWorklet.addModule('audio-processor.worklet.js');
    this.#workletNode = new AudioWorkletNode(this.#audioContext, 'audio-processor');
    this.#gainNode.connect(this.#workletNode);

    // Receive PCM Int16 chunks from worklet
    this.#workletNode.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; buffer: ArrayBuffer };
      if (data.type === 'audio') {
        this.#processAudioData(new Int16Array(data.buffer));
      }
    };
  }

  async stop(): Promise<void> {
    this.#workletNode?.disconnect();
    this.#workletNode = null;
    this.#gainNode?.disconnect();
    this.#gainNode = null;

    if (this.#mediaStream) {
      for (const track of this.#mediaStream.getTracks()) {
        track.stop();
      }
      this.#mediaStream = null;
    }

    if (this.#audioContext) {
      await this.#audioContext.close();
      this.#audioContext = null;
    }

    this.#buffer = new Int16Array(CHUNK_SIZE);
    this.#bufferOffset = 0;
    this.#vadState = { status: 'silence' };
  }

  mute(): void {
    this.#muted = true;
  }

  unmute(): void {
    this.#muted = false;
  }

  setGhostMode(enabled: boolean): void {
    this.#ghostMode = enabled;
    this.#config.noiseGateThresholdDb = enabled ? -55 : -40;
    this.#config.ghostModeGainDb = enabled ? 20 : 0;

    if (this.#gainNode) {
      this.#gainNode.gain.value = enabled
        ? Math.pow(10, 20 / 20) // +20dB
        : 1;
    }
  }

  getCurrentLevel(): number {
    // Return last computed RMS for UI meters
    return computeRmsDb(this.#buffer.subarray(0, this.#bufferOffset));
  }

  getSequenceId(): number {
    return this.#sequenceId;
  }

  #processAudioData(samples: Int16Array): void {
    if (this.#muted) return;

    // Run VAD on 10ms frames
    for (let i = 0; i < samples.length; i += VAD_FRAME_SIZE) {
      const frame = samples.subarray(i, Math.min(i + VAD_FRAME_SIZE, samples.length));
      const energyDb = computeRmsDb(frame);
      const prevState = this.#vadState;

      this.#vadState = transitionVADState(
        this.#vadState,
        energyDb,
        this.#config.noiseGateThresholdDb,
        Date.now(),
        this.#config.vadSpeechOnsetMs,
        this.#config.vadSpeechOffsetMs
      );

      if (this.#vadState.status !== prevState.status) {
        this.onVADStateChange?.(this.#vadState);

        // Speech ended — signal STT to commit
        if (prevState.status === 'silence-pending' && this.#vadState.status === 'silence') {
          this.onSpeechEnd?.();
        }
      }
    }

    // Noise gate: only buffer if above threshold
    const chunkEnergy = computeRmsDb(samples);
    if (chunkEnergy <= this.#config.noiseGateThresholdDb) return;

    // Accumulate into ring buffer, emit 250ms chunks
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
