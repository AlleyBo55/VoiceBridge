/**
 * Native audio addon — REAL implementation using ffmpeg.
 *
 * Mic capture: ffmpeg reads from the system default mic via avfoundation (macOS),
 *   alsa/pulse (Linux), or dshow (Windows), outputs raw PCM s16le at 16kHz mono.
 *
 * Virtual mic output: ffmpeg reads raw PCM from stdin and writes to BlackHole
 *   (macOS), PulseAudio sink (Linux), or VB-CABLE (Windows).
 *
 * Falls back to MockNativeAddon if ffmpeg is not available.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import type { AudioDeviceInfo, CaptureConfig, DriverInstallResult, DriverStatus } from '../shared/types.js';

// ── Interface ───────────────────────────────────────────────

export interface NativeAudioAddon {
  enumerateInputDevices(): AudioDeviceInfo[];
  getDefaultInputDevice(): AudioDeviceInfo | null;
  startCapture(deviceId: string, config: CaptureConfig): void;
  stopCapture(): void;
  setCaptureGain(gainDb: number): void;
  onAudioChunk: ((pcm: Buffer, sequenceId: number) => void) | null;
  isDriverInstalled(): boolean;
  getDriverVersion(): string | null;
  installDriver(): DriverInstallResult;
  uninstallDriver(): boolean;
  writeVirtualMic(pcm: Buffer): void;
  getDriverStatus(): DriverStatus;
  resample(pcm: Buffer, fromRate: number, toRate: number): Buffer;
}

// ── Real Implementation (ffmpeg) ────────────────────────────

export class FfmpegNativeAddon implements NativeAudioAddon {
  #captureProcess: ChildProcess | null = null;
  #outputProcess: ChildProcess | null = null;
  #sequenceId = 0;
  #capturing = false;

  onAudioChunk: ((pcm: Buffer, sequenceId: number) => void) | null = null;

  enumerateInputDevices(): AudioDeviceInfo[] {
    try {
      if (process.platform === 'darwin') {
        const out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', { encoding: 'utf8', timeout: 5000 });
        const devices: AudioDeviceInfo[] = [];
        let inAudio = false;
        let idx = 0;
        for (const line of out.split('\n')) {
          if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
          if (inAudio && line.includes('] ') && !line.includes('screen')) {
            const match = line.match(/\[(\d+)]\s+(.+)/);
            if (match) {
              devices.push({
                id: match[1] ?? String(idx),
                name: (match[2] ?? '').trim(),
                sampleRate: 48000,
                channels: 1,
                isDefault: idx === 0,
              });
              idx++;
            }
          }
        }
        return devices.length > 0 ? devices : [{ id: 'default', name: 'Default Microphone', sampleRate: 48000, channels: 1, isDefault: true }];
      }
    } catch {}
    return [{ id: 'default', name: 'Default Microphone', sampleRate: 48000, channels: 1, isDefault: true }];
  }

  getDefaultInputDevice(): AudioDeviceInfo | null {
    const devices = this.enumerateInputDevices();
    // Skip virtual devices (BlackHole, VB-Cable) — prefer real mic
    const realMic = devices.find(d => !d.name.toLowerCase().includes('blackhole') && !d.name.toLowerCase().includes('cable'));
    return realMic ?? devices[0] ?? null;
  }

  startCapture(deviceId: string, config: CaptureConfig): void {
    if (this.#capturing) return;
    this.#capturing = true;

    const args = this.#buildCaptureArgs(deviceId, config);
    console.log('[Audio] Starting capture:', 'ffmpeg', args.join(' '));

    this.#captureProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });

    const bytesPerChunk = (config.sampleRate * config.bufferSizeMs / 1000) * 2; // Int16 = 2 bytes
    let buffer = Buffer.alloc(0);

    this.#captureProcess.stdout?.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= bytesPerChunk) {
        const chunk = buffer.subarray(0, bytesPerChunk);
        buffer = buffer.subarray(bytesPerChunk);
        this.#sequenceId++;
        this.onAudioChunk?.(chunk, this.#sequenceId);
      }
    });

    this.#captureProcess.on('error', (err) => {
      console.error('[Audio] Capture error:', err.message);
    });

    this.#captureProcess.on('close', (code) => {
      console.log('[Audio] Capture process exited:', code);
      this.#capturing = false;
    });
  }

  stopCapture(): void {
    this.#capturing = false;
    if (this.#captureProcess) {
      this.#captureProcess.kill('SIGTERM');
      this.#captureProcess = null;
    }
  }

  setCaptureGain(_gainDb: number): void {
    // Would need to restart capture with volume filter — skip for now
  }

  /** Write PCM audio to the virtual mic (BlackHole / PulseAudio sink). */
  writeVirtualMic(pcm: Buffer): void {
    if (!this.#outputProcess || this.#outputProcess.killed) {
      this.#startOutputProcess();
    }
    try {
      this.#outputProcess?.stdin?.write(pcm);
    } catch {
      // Pipe broken — restart
      this.#startOutputProcess();
      try { this.#outputProcess?.stdin?.write(pcm); } catch {}
    }
  }

  isDriverInstalled(): boolean { return false; }
  getDriverVersion(): string | null { return null; }
  installDriver(): DriverInstallResult { return { success: false, error: 'Use DriverInstaller' }; }
  uninstallDriver(): boolean { return false; }
  getDriverStatus(): DriverStatus { return { state: 'not-installed' }; }

  resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return pcm;
    const ratio = toRate / fromRate;
    const inputSamples = Math.floor(pcm.length / 2); // ensure even
    if (inputSamples === 0) return Buffer.alloc(0);
    const outputSamples = Math.ceil(inputSamples * ratio);
    const output = Buffer.alloc(outputSamples * 2);
    const maxOffset = (inputSamples - 1) * 2;
    for (let i = 0; i < outputSamples; i++) {
      const srcIndex = i / ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, inputSamples - 1);
      const frac = srcIndex - low;
      const lowOff = Math.min(low * 2, maxOffset);
      const highOff = Math.min(high * 2, maxOffset);
      const sampleLow = pcm.readInt16LE(lowOff);
      const sampleHigh = pcm.readInt16LE(highOff);
      const interpolated = Math.round(sampleLow * (1 - frac) + sampleHigh * frac);
      output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }
    return output;
  }

  // ── Private ─────────────────────────────────────────────────

  #buildCaptureArgs(deviceId: string, config: CaptureConfig): string[] {
    if (process.platform === 'darwin') {
      // avfoundation: ":audioDeviceIndex" for audio-only
      const devIdx = deviceId === 'default' ? '0' : deviceId;
      return [
        '-f', 'avfoundation', '-i', `:${devIdx}`,
        '-ar', String(config.sampleRate),
        '-ac', String(config.channels),
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        'pipe:1',
      ];
    }
    if (process.platform === 'linux') {
      return [
        '-f', 'pulse', '-i', 'default',
        '-ar', String(config.sampleRate),
        '-ac', String(config.channels),
        '-f', 's16le',
        'pipe:1',
      ];
    }
    // Windows
    return [
      '-f', 'dshow', '-i', 'audio=Microphone',
      '-ar', String(config.sampleRate),
      '-ac', String(config.channels),
      '-f', 's16le',
      'pipe:1',
    ];
  }

  #startOutputProcess(): void {
    if (this.#outputProcess && !this.#outputProcess.killed) {
      this.#outputProcess.kill('SIGTERM');
    }

    let args: string[];

    if (process.platform === 'darwin') {
      // Find BlackHole device index
      const bhIdx = this.#findBlackHoleIndex();
      if (bhIdx === null) {
        console.error('[Audio] BlackHole device not found — cannot output');
        return;
      }
      args = [
        '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
        '-f', 'audiotoolbox', '-audio_device_index', String(bhIdx),
        '-',
      ];
    } else if (process.platform === 'linux') {
      args = [
        '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
        '-f', 'pulse', 'voicebridge',
      ];
    } else {
      args = [
        '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
        '-f', 'dshow', 'audio=CABLE Input',
      ];
    }

    console.log('[Audio] Starting output:', 'ffmpeg', args.join(' '));
    this.#outputProcess = spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    this.#outputProcess.on('error', (err) => {
      console.error('[Audio] Output error:', err.message);
    });

    this.#outputProcess.on('close', (code) => {
      console.log('[Audio] Output process exited:', code);
    });
  }

  #findBlackHoleIndex(): number | null {
    try {
      const out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', { encoding: 'utf8', timeout: 5000 });
      let inAudio = false;
      for (const line of out.split('\n')) {
        if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
        if (inAudio && line.toLowerCase().includes('blackhole')) {
          const match = line.match(/\[(\d+)]/);
          if (match) return parseInt(match[1] ?? '0', 10);
        }
      }
    } catch {}
    return null;
  }

  destroy(): void {
    this.stopCapture();
    if (this.#outputProcess && !this.#outputProcess.killed) {
      this.#outputProcess.kill('SIGTERM');
      this.#outputProcess = null;
    }
  }
}

// ── Mock Implementation (fallback) ──────────────────────────

export class MockNativeAddon implements NativeAudioAddon {
  #capturing = false;
  #captureTimer: ReturnType<typeof setInterval> | null = null;
  #sequenceId = 0;
  #driverInstalled = false;

  onAudioChunk: ((pcm: Buffer, sequenceId: number) => void) | null = null;

  enumerateInputDevices(): AudioDeviceInfo[] {
    return [{ id: 'default', name: 'Default Microphone', sampleRate: 48000, channels: 1, isDefault: true }];
  }
  getDefaultInputDevice(): AudioDeviceInfo | null { return this.enumerateInputDevices()[0] ?? null; }
  startCapture(_deviceId: string, config: CaptureConfig): void {
    if (this.#capturing) return;
    this.#capturing = true;
    const bytesPerChunk = (config.sampleRate * config.bufferSizeMs / 1000) * 2;
    this.#captureTimer = setInterval(() => {
      this.#sequenceId++;
      this.onAudioChunk?.(Buffer.alloc(bytesPerChunk, 0), this.#sequenceId);
    }, config.bufferSizeMs);
  }
  stopCapture(): void {
    this.#capturing = false;
    if (this.#captureTimer) { clearInterval(this.#captureTimer); this.#captureTimer = null; }
  }
  setCaptureGain(_gainDb: number): void {}
  isDriverInstalled(): boolean { return this.#driverInstalled; }
  getDriverVersion(): string | null { return this.#driverInstalled ? '1.0.0' : null; }
  installDriver(): DriverInstallResult { this.#driverInstalled = true; return { success: true }; }
  uninstallDriver(): boolean { this.#driverInstalled = false; return true; }
  writeVirtualMic(_pcm: Buffer): void {}
  getDriverStatus(): DriverStatus {
    return this.#driverInstalled ? { state: 'installed', version: '1.0.0', active: true, sampleRate: 48000 } : { state: 'not-installed' };
  }
  resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return pcm;
    const ratio = toRate / fromRate;
    const inputSamples = Math.floor(pcm.length / 2);
    if (inputSamples === 0) return Buffer.alloc(0);
    const outputSamples = Math.ceil(inputSamples * ratio);
    const output = Buffer.alloc(outputSamples * 2);
    const maxOff = (inputSamples - 1) * 2;
    for (let i = 0; i < outputSamples; i++) {
      const srcIndex = i / ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, inputSamples - 1);
      const frac = srcIndex - low;
      output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(Math.min(low * 2, maxOff)) * (1 - frac) + pcm.readInt16LE(Math.min(high * 2, maxOff)) * frac))), i * 2);
    }
    return output;
  }
}

// ── Factory ─────────────────────────────────────────────────

/** Create the best available native addon. Uses ffmpeg if available, falls back to mock. */
export function createNativeAddon(): NativeAudioAddon {
  try {
    execSync('which ffmpeg', { encoding: 'utf8', timeout: 2000 });
    console.log('[Audio] Using FfmpegNativeAddon (real mic capture + BlackHole output)');
    return new FfmpegNativeAddon();
  } catch {
    console.warn('[Audio] ffmpeg not found — using MockNativeAddon (no real audio)');
    return new MockNativeAddon();
  }
}
