/**
 * N-API native addon TypeScript interface and mock implementation.
 * The real implementation will be in Rust (napi-rs) for cross-platform
 * audio device access. This mock enables development and testing.
 */

import type { AudioDeviceInfo, CaptureConfig, DriverInstallResult, DriverStatus } from '../shared/types.js';

// ── Interface ───────────────────────────────────────────────

/** Native addon interface exposed to the main process */
export interface NativeAudioAddon {
  // Device enumeration
  enumerateInputDevices(): AudioDeviceInfo[];
  getDefaultInputDevice(): AudioDeviceInfo | null;

  // Real mic capture
  startCapture(deviceId: string, config: CaptureConfig): void;
  stopCapture(): void;
  setCaptureGain(gainDb: number): void;
  onAudioChunk: ((pcm: Buffer, sequenceId: number) => void) | null;

  // Virtual mic driver
  isDriverInstalled(): boolean;
  getDriverVersion(): string | null;
  installDriver(): DriverInstallResult;
  uninstallDriver(): boolean;
  writeVirtualMic(pcm: Buffer): void;
  getDriverStatus(): DriverStatus;

  // Resampling
  resample(pcm: Buffer, fromRate: number, toRate: number): Buffer;
}

// ── Mock Implementation ─────────────────────────────────────

/**
 * Mock native addon for development and testing.
 * Simulates audio capture with silence and provides stub driver operations.
 */
export class MockNativeAddon implements NativeAudioAddon {
  #capturing = false;
  #captureTimer: ReturnType<typeof setInterval> | null = null;
  #sequenceId = 0;
  #driverInstalled = false;

  onAudioChunk: ((pcm: Buffer, sequenceId: number) => void) | null = null;

  enumerateInputDevices(): AudioDeviceInfo[] {
    return [
      { id: 'default', name: 'Default Microphone', sampleRate: 48000, channels: 1, isDefault: true },
      { id: 'mock-usb', name: 'USB Microphone', sampleRate: 44100, channels: 1, isDefault: false },
    ];
  }

  getDefaultInputDevice(): AudioDeviceInfo | null {
    return this.enumerateInputDevices()[0] ?? null;
  }

  startCapture(_deviceId: string, config: CaptureConfig): void {
    if (this.#capturing) return;
    this.#capturing = true;

    const samplesPerChunk = (config.sampleRate * config.bufferSizeMs) / 1000;
    const bytesPerChunk = samplesPerChunk * 2; // Int16 = 2 bytes per sample

    // Emit silence chunks at the configured interval
    this.#captureTimer = setInterval(() => {
      if (!this.#capturing) return;
      this.#sequenceId++;
      const silence = Buffer.alloc(bytesPerChunk, 0);
      this.onAudioChunk?.(silence, this.#sequenceId);
    }, config.bufferSizeMs);
  }

  stopCapture(): void {
    this.#capturing = false;
    if (this.#captureTimer) {
      clearInterval(this.#captureTimer);
      this.#captureTimer = null;
    }
  }

  setCaptureGain(_gainDb: number): void {
    // Mock: no-op
  }

  isDriverInstalled(): boolean {
    return this.#driverInstalled;
  }

  getDriverVersion(): string | null {
    return this.#driverInstalled ? '1.0.0' : null;
  }

  installDriver(): DriverInstallResult {
    this.#driverInstalled = true;
    return { success: true };
  }

  uninstallDriver(): boolean {
    this.#driverInstalled = false;
    return true;
  }

  writeVirtualMic(_pcm: Buffer): void {
    // Mock: discard audio
  }

  getDriverStatus(): DriverStatus {
    if (this.#driverInstalled) {
      return { state: 'installed', version: '1.0.0', active: true, sampleRate: 48000 };
    }
    return { state: 'not-installed' };
  }

  resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return pcm;

    const ratio = toRate / fromRate;
    const inputSamples = pcm.length / 2; // Int16
    const outputSamples = Math.ceil(inputSamples * ratio);
    const output = Buffer.alloc(outputSamples * 2);

    // Linear interpolation resampling
    for (let i = 0; i < outputSamples; i++) {
      const srcIndex = i / ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, inputSamples - 1);
      const frac = srcIndex - low;

      const sampleLow = pcm.readInt16LE(low * 2);
      const sampleHigh = pcm.readInt16LE(high * 2);
      const interpolated = Math.round(sampleLow * (1 - frac) + sampleHigh * frac);

      output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    return output;
  }
}
