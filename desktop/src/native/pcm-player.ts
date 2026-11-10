/**
 * Streams translated speech (raw PCM s16le mono) to the system output device.
 *
 * Why: the old path wrote one MP3 per utterance to disk, re-encoded it with ffmpeg for a
 * volume boost and only then started afplay, so nothing played until the whole utterance
 * was synthesized. Here one long-lived player process reads PCM from stdin for the whole
 * session and plays each chunk as it arrives.
 *
 * Player order: sox `play` (a VoiceBridge prerequisite) → `ffplay` (ships with most ffmpeg
 * builds, including Windows ones) → per-utterance WAV through afplay / paplay / PowerShell.
 * The meeting app hears it when the system output (or a Multi-Output Device) includes the
 * virtual mic driver, exactly as with the previous afplay path.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** A session-long audio output. All methods are safe to call at any time. */
export interface PcmOutputStream {
  /** Queue PCM s16le mono at the stream's sample rate. Odd trailing bytes are carried over. */
  write(pcm: Buffer): void;
  /** End of an utterance. Streaming players ignore it; the WAV fallback plays what it has. */
  flush(): void;
  /** Drop queued audio and go silent now (panic / stop). The stream stays usable. */
  interrupt(): void;
  /** Close after queued audio has played. */
  close(): void;
}

/**
 * Linear gain before the soft limiter. The old MP3 path multiplied by 6 and hard-clipped
 * every loud syllable (audible crackle). 2× with tanh limiting stays clean; meeting apps'
 * automatic gain control evens out the rest.
 */
const OUTPUT_GAIN = 2.0;
/** The WAV fallback holds audio in memory until flush(); never more than this. */
const MAX_FALLBACK_SECONDS = 10;

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;
interface PlayerCommand { name: 'play' | 'ffplay'; cmd: string; args: string[] }

function commandExists(name: string): boolean {
  try {
    if (process.platform === 'win32') execSync(`where ${name}`, { stdio: 'ignore', timeout: 2000 });
    else execSync(`command -v ${name}`, { stdio: 'ignore', timeout: 2000, shell: '/bin/sh' });
    return true;
  } catch {
    return false; // not installed: the caller falls back to the next player
  }
}

/** PERF: both players are told to buffer as little as they safely can. */
function pickPlayer(sampleRate: number): PlayerCommand | null {
  const rate = String(sampleRate);
  // SoX for Windows ships no play.exe, so `play` is only looked up on macOS and Linux.
  if (process.platform !== 'win32' && commandExists('play')) {
    return { name: 'play', cmd: 'play', args: ['-q', '--buffer', '4096', '-t', 'raw', '-r', rate, '-e', 'signed-integer', '-b', '16', '-c', '1', '-'] };
  }
  if (commandExists('ffplay')) {
    // Raw s16le input defaults to mono, which avoids -ac/-ch_layout differences between ffmpeg versions.
    return { name: 'ffplay', cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'error', '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', rate, '-i', 'pipe:0'] };
  }
  return null;
}

/**
 * PERF: gain plus tanh soft limiting, one pass per chunk. Quiet speech passes almost linearly;
 * peaks bend smoothly towards full scale instead of clipping into crackle.
 */
export function applySoftGain(pcm: Buffer, gain: number): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const x = (pcm.readInt16LE(i) / 32768) * gain;
    out.writeInt16LE(Math.round(Math.tanh(x) * 32767), i);
  }
  return out;
}

/** Minimal 44-byte WAV header for PCM s16le mono. */
function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

function wavPlayerCommand(path: string): { cmd: string; args: string[] } | null {
  if (process.platform === 'darwin') return { cmd: 'afplay', args: [path] };
  if (process.platform === 'linux') return { cmd: 'paplay', args: [path] };
  if (process.platform === 'win32') {
    // SECURITY: the path is ours (tmpdir + timestamp); single quotes are escaped for PowerShell anyway.
    const quoted = path.replace(/'/g, "''");
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${quoted}').PlaySync()`] };
  }
  return null;
}

/** Streaming PCM output backed by sox `play` or `ffplay`, with a WAV-per-utterance fallback. */
export class PcmPlayer implements PcmOutputStream {
  readonly #sampleRate: number;
  readonly #log: Log;
  #command: PlayerCommand | null;
  #proc: ChildProcess | null = null;
  #carry: Buffer | null = null; // odd trailing byte from the previous write
  #pending: Buffer[] = []; // WAV fallback only
  #pendingBytes = 0;
  #wavQueue: Promise<void> = Promise.resolve();
  #wavProc: ChildProcess | null = null;
  #closed = false;

  constructor(sampleRate: number, log: Log) {
    this.#sampleRate = sampleRate;
    this.#log = log;
    this.#command = pickPlayer(sampleRate);
    log('info', this.#command
      ? `Audio output: streaming through ${this.#command.name} at ${sampleRate} Hz`
      : 'Audio output: neither sox `play` nor ffplay found; playing one WAV per utterance (higher delay). Install sox for streaming.');
    // PERF: start the player now so its startup doesn't delay the first translated word.
    if (this.#command) this.#ensureProcess();
  }

  write(pcm: Buffer): void {
    if (this.#closed || pcm.length === 0) return;
    let data = this.#carry ? Buffer.concat([this.#carry, pcm]) : pcm;
    this.#carry = data.length % 2 === 1 ? data.subarray(data.length - 1) : null;
    if (this.#carry) data = data.subarray(0, data.length - 1);
    if (data.length === 0) return;
    const out = applySoftGain(data, OUTPUT_GAIN);

    const proc = this.#command ? this.#ensureProcess() : null;
    if (proc?.stdin?.writable) {
      proc.stdin.write(out);
      return;
    }
    this.#pending.push(out);
    this.#pendingBytes += out.length;
    if (this.#pendingBytes >= this.#sampleRate * 2 * MAX_FALLBACK_SECONDS) this.flush();
  }

  flush(): void {
    if (this.#pendingBytes === 0) return;
    const data = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#pendingBytes = 0;
    // Utterances play one after another, never on top of each other.
    this.#wavQueue = this.#wavQueue.then(() => this.#playWav(data)).catch((err: unknown) => {
      this.#log('error', `Audio output: WAV playback failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  interrupt(): void {
    this.#carry = null;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#wavProc?.kill('SIGKILL');
    this.#wavProc = null;
    const proc = this.#proc;
    this.#proc = null;
    proc?.kill('SIGKILL');
    // Respawn so the next utterance doesn't pay the startup cost.
    if (!this.#closed && this.#command) this.#ensureProcess();
  }

  close(): void {
    if (this.#closed) return;
    this.flush();
    this.#closed = true;
    this.#proc?.stdin?.end();
    this.#proc = null;
  }

  #ensureProcess(): ChildProcess | null {
    if (this.#proc && this.#proc.exitCode === null && !this.#proc.killed) return this.#proc;
    const command = this.#command;
    if (!command) return null;
    const proc = spawn(command.cmd, command.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    this.#proc = proc;
    proc.on('error', (err) => {
      this.#log('warn', `Audio output: ${command.name} failed (${err.message}); falling back to WAV playback`);
      if (this.#proc === proc) this.#proc = null;
      this.#command = null;
    });
    proc.on('exit', (code) => {
      if (this.#proc === proc) this.#proc = null;
      if (code !== 0 && code !== null && !this.#closed) this.#log('warn', `Audio output: ${command.name} exited with code ${code}; restarting on the next chunk`);
    });
    // EPIPE when the player dies mid-write; 'exit' handles the restart.
    proc.stdin?.on('error', (err) => this.#log('warn', `Audio output: ${command.name} input closed (${err.message})`));
    return proc;
  }

  #playWav(data: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const path = join(tmpdir(), `vb-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
      const command = wavPlayerCommand(path);
      if (!command) { resolve(); return; }
      writeFileSync(path, Buffer.concat([wavHeader(data.length, this.#sampleRate), data]));
      const proc = spawn(command.cmd, command.args, { stdio: 'ignore', windowsHide: true });
      this.#wavProc = proc;
      const done = (): void => {
        try { unlinkSync(path); } catch { /* already removed */ }
        if (this.#wavProc === proc) this.#wavProc = null;
        resolve();
      };
      proc.on('close', done);
      proc.on('error', (err) => { this.#log('error', `Audio output: ${command.cmd} failed: ${err.message}`); done(); });
    });
  }
}

/** Output that discards everything (mock addon, tests). */
export class NullPcmOutput implements PcmOutputStream {
  write(_pcm: Buffer): void {}
  flush(): void {}
  interrupt(): void {}
  close(): void {}
}
