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
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
  writeVirtualMic(audio: Buffer, sampleRate?: number): void;
  getDriverStatus(): DriverStatus;
  resample(pcm: Buffer, fromRate: number, toRate: number): Buffer;
}

// ── Real Implementation (ffmpeg) ────────────────────────────

export class FfmpegNativeAddon implements NativeAudioAddon {
  #captureProcess: ChildProcess | null = null;
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
                id: (match[2] ?? '').trim(),  // Use NAME as ID (indices change when devices plug/unplug)
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
  #outputChunkCount = 0;

  writeVirtualMic(audio: Buffer, _sampleRate = 44100): void {
    this.#outputChunkCount++;
    if (this.#outputChunkCount <= 5 || this.#outputChunkCount % 20 === 0) {
      console.log(`[Audio] Writing ${audio.length} bytes to virtual mic (chunk #${this.#outputChunkCount})`);
    }

    // Write MP3 to BlackHole / virtual mic via sox or paplay.
    this.#playToBlackHole(audio);
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
      // Resolve device name to current avfoundation index (indices change when devices plug/unplug)
      const devIdx = this.#resolveDeviceIndex(deviceId);
      console.log(`[Audio] Resolved mic "${deviceId}" → avfoundation index :${devIdx}`);
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

  #bhIdx: number | null = null;

  /** Play PCM to BlackHole via a short-lived ffmpeg (no persistent pipe = no buffering) */
  #playToBlackHole(audio: Buffer): void {
    if (process.platform === 'darwin') {
      // Find BlackHole audiotoolbox device index
      if (this.#bhIdx === null) {
        this.#bhIdx = this.#findBlackHoleIndex();
        if (this.#bhIdx === null) {
          console.error('[Audio] BlackHole device not found — cannot output');
          return;
        }
        console.log(`[Audio] Found BlackHole at audiotoolbox index ${this.#bhIdx}`);
      }

      // Write MP3 to temp file, then use ffmpeg to decode and play to BlackHole.
      const mp3Path = join(tmpdir(), `vb-tts-${Date.now()}.mp3`);
      writeFileSync(mp3Path, audio);
      console.log(`[Audio] Wrote ${audio.length} bytes to ${mp3Path}`);

      // audiotoolbox output with volume boost — empty string as output path
      const args = [
        '-y',
        '-i', mp3Path,
        '-af', 'volume=3.0',
        '-f', 'audiotoolbox',
        '-audio_device_index', String(this.#bhIdx),
        '',
      ];

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderrData = '';
      proc.stdout?.on('data', () => {}); // drain stdout
      proc.stderr?.on('data', (chunk: Buffer) => { stderrData += chunk.toString(); });

      proc.on('close', (code) => {
        console.log(`[Audio] ffmpeg→BlackHole exited code=${code}`);
        if (code !== 0) {
          console.error(`[Audio] ffmpeg stderr: ${stderrData.slice(-500)}`);
        }
        try { unlinkSync(mp3Path); } catch(_e2) {}
      });

      // Also play through default speakers (boosted) so user can hear locally.
      spawn('afplay', ['--volume', '2', mp3Path], { stdio: 'ignore' });
      proc.on('error', (err) => {
        console.error(`[Audio] ffmpeg spawn error: ${err.message}`);
        try { unlinkSync(mp3Path); } catch(_e3) {}
      });
    } else if (process.platform === 'linux') {
      // Write MP3 to temp file, use ffmpeg to decode and output to PulseAudio sink
      const mp3Path = join(tmpdir(), `vb-tts-${Date.now()}.mp3`);
      writeFileSync(mp3Path, audio);

      const proc = spawn('ffmpeg', [
        '-y',
        '-i', mp3Path,
        '-af', 'volume=3.0',
        '-f', 'pulse', 'voicebridge',
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      proc.on('close', () => { try { unlinkSync(mp3Path); } catch(_e) {} });
      proc.on('error', () => { try { unlinkSync(mp3Path); } catch(_e) {} });
    }
  }

  // Speaker playback — plays TTS audio through default speakers using afplay (macOS built-in)
  #speakerPlayCount = 0;

  /** Write raw PCM to a temp WAV file and play it with afplay (immediate, no buffering).
   * Currently unused — kept for future "monitor" toggle to hear translations locally. */
  // @ts-expect-error Retained for future speaker monitor feature
  #playThroughSpeaker(pcm: Buffer): void {
    if (process.platform !== 'darwin') return;

    this.#speakerPlayCount++;
    const wavPath = join(tmpdir(), `vb-tts-${this.#speakerPlayCount}.wav`);

    try {
      // Build WAV header for 48kHz mono 16-bit PCM
      const header = Buffer.alloc(44);
      const dataSize = pcm.length;
      const fileSize = 36 + dataSize;

      header.write('RIFF', 0);
      header.writeUInt32LE(fileSize, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);       // fmt chunk size
      header.writeUInt16LE(1, 20);        // PCM format
      header.writeUInt16LE(1, 22);        // mono
      header.writeUInt32LE(48000, 24);    // sample rate
      header.writeUInt32LE(96000, 28);    // byte rate (48000 * 1 * 2)
      header.writeUInt16LE(2, 32);        // block align
      header.writeUInt16LE(16, 34);       // bits per sample
      header.write('data', 36);
      header.writeUInt32LE(dataSize, 40);

      writeFileSync(wavPath, Buffer.concat([header, pcm]));

      // Play async — afplay returns immediately-ish and plays in background
      const player = spawn('afplay', [wavPath], { stdio: 'ignore' });
      player.on('close', () => {
        try { unlinkSync(wavPath); } catch(_e4) {}
      });
      player.on('error', () => {
        try { unlinkSync(wavPath); } catch(_e5) {}
      });
    } catch(_e) {
      console.error('[Audio] Speaker playback failed');
    }
  }

  /** Resolve a device name (or index string) to the current avfoundation audio index */
  #resolveDeviceIndex(deviceId: string): string {
    // If it's already a pure number, use it directly (legacy)
    if (/^\d+$/.test(deviceId)) return deviceId;

    // If it's 'default', find the first non-virtual device
    if (deviceId === 'default') {
      const dev = this.getDefaultInputDevice();
      if (dev) return this.#resolveDeviceIndex(dev.id);
      return '0';
    }

    // Search by name in the current device list
    try {
      const out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', { encoding: 'utf8', timeout: 5000 });
      let inAudio = false;
      for (const line of out.split('\n')) {
        if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
        if (inAudio) {
          const match = line.match(/\[(\d+)]\s+(.+)/);
          if (match) {
            const name = (match[2] ?? '').trim();
            if (name === deviceId || name.toLowerCase().includes(deviceId.toLowerCase())) {
              return match[1] ?? '0';
            }
          }
        }
      }
    } catch {}

    // Fallback: try as-is
    return '0';
  }

  /** Find BlackHole audiotoolbox device index using ffmpeg device listing. */
  #findBlackHoleIndex(): number | null {
    try {
      // List audiotoolbox output devices by providing a dummy input
      const out = execSync(
        'ffmpeg -f s16le -ar 48000 -ac 1 -i /dev/zero -t 0.001 -f audiotoolbox -list_devices true "" 2>&1 || true',
        { encoding: 'utf8', timeout: 5000 }
      );
      for (const line of out.split('\n')) {
        if (line.toLowerCase().includes('blackhole')) {
          const match = line.match(/\[(\d+)]/);
          if (match?.[1]) {
            return parseInt(match[1], 10);
          }
        }
      }
    } catch {}
    return null;
  }

  destroy(): void {
    this.stopCapture();
    this.#outputChunkCount = 0;
    this.#bhIdx = null;
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
  writeVirtualMic(_audio: Buffer, _sampleRate?: number): void {}
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
