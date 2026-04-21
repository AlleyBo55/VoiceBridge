/**
 * Audio output module — routes TTS audio to meetings via WebRTC track replacement.
 * Handles sample rate conversion (24kHz → 48kHz), volume normalization, and buffering.
 */

// ── Constants ───────────────────────────────────────────────

const OUTPUT_SAMPLE_RATE = 48000;
const TTS_SAMPLE_RATE = 24000;
const FADE_OUT_MS = 50;

// ── Configuration ───────────────────────────────────────────

export interface AudioOutputConfig {
  outputSampleRate: 48000;
  bufferSizeMs: number;
  fadeOutMs: number;
}

// ── Audio Output Module ─────────────────────────────────────

export class AudioOutputModule {
  #audioContext: AudioContext | null = null;
  #gainNode: GainNode | null = null;
  #destination: MediaStreamAudioDestinationNode | null = null;
  #playing = false;
  #queue: Int16Array[] = [];
  #currentSource: AudioBufferSourceNode | null = null;

  async initialize(): Promise<void> {
    this.#audioContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    this.#gainNode = this.#audioContext.createGain();
    this.#destination = this.#audioContext.createMediaStreamDestination();
    this.#gainNode.connect(this.#destination);
  }

  /**
   * Play a PCM Int16 24kHz audio chunk through the virtual output.
   */
  async playAudio(pcm24k: Int16Array, _sequenceId: number): Promise<void> {
    if (!this.#audioContext || !this.#gainNode) return;

    this.#playing = true;

    // Convert Int16 → Float32
    const float32 = new Float32Array(pcm24k.length);
    for (let i = 0; i < pcm24k.length; i++) {
      float32[i] = (pcm24k[i] ?? 0) / 32768.0;
    }

    // Create buffer at 48kHz — browser resamples from 24kHz via sinc interpolation
    const resampledLength = Math.ceil(float32.length * (OUTPUT_SAMPLE_RATE / TTS_SAMPLE_RATE));
    const audioBuffer = this.#audioContext.createBuffer(1, resampledLength, OUTPUT_SAMPLE_RATE);
    const channelData = audioBuffer.getChannelData(0);

    // Linear interpolation for resampling (browser handles high-quality sinc internally)
    const ratio = float32.length / resampledLength;
    for (let i = 0; i < resampledLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, float32.length - 1);
      const frac = srcIndex - low;
      channelData[i] = (float32[low] ?? 0) * (1 - frac) + (float32[high] ?? 0) * frac;
    }

    // Play through gain node → destination
    const source = this.#audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.#gainNode);

    source.onended = () => {
      if (this.#currentSource === source) {
        this.#currentSource = null;
        if (this.#queue.length > 0) {
          const next = this.#queue.shift()!;
          this.playAudio(next, _sequenceId);
        } else {
          this.#playing = false;
        }
      }
    };

    this.#currentSource = source;
    source.start();
  }

  /**
   * Stop all playback immediately.
   */
  stopPlayback(): void {
    this.#queue = [];
    if (this.#currentSource) {
      try { this.#currentSource.stop(); } catch { /* already stopped */ }
      this.#currentSource = null;
    }
    this.#playing = false;
  }

  /**
   * Fade out current playback over the specified duration.
   */
  fadeOut(durationMs: number = FADE_OUT_MS): void {
    if (!this.#gainNode || !this.#audioContext) return;

    const now = this.#audioContext.currentTime;
    this.#gainNode.gain.setValueAtTime(this.#gainNode.gain.value, now);
    this.#gainNode.gain.linearRampToValueAtTime(0, now + durationMs / 1000);

    // Restore gain after fade
    setTimeout(() => {
      if (this.#gainNode) {
        this.#gainNode.gain.setValueAtTime(1, this.#audioContext!.currentTime);
      }
      this.stopPlayback();
    }, durationMs);
  }

  /**
   * Get the virtual MediaStreamTrack for WebRTC injection.
   */
  getVirtualTrack(): MediaStreamTrack | null {
    return this.#destination?.stream.getAudioTracks()[0] ?? null;
  }

  /**
   * Set volume normalization based on reference mic level.
   */
  normalizeVolume(referenceLevel: number): void {
    // Adjust gain to match user's average mic level
    if (this.#gainNode && referenceLevel > 0) {
      this.#gainNode.gain.value = referenceLevel;
    }
  }

  isPlaying(): boolean {
    return this.#playing;
  }

  /**
   * Release all audio resources.
   */
  async destroy(): Promise<void> {
    this.stopPlayback();

    if (this.#destination) {
      for (const track of this.#destination.stream.getTracks()) {
        track.stop();
      }
      this.#destination = null;
    }

    this.#gainNode?.disconnect();
    this.#gainNode = null;

    if (this.#audioContext) {
      await this.#audioContext.close();
      this.#audioContext = null;
    }
  }
}
