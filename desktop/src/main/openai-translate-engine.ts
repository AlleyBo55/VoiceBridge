/**
 * OpenAI GPT-Realtime-Translate engine: the Realtime translation WebSocket API (GA, no OpenAI-Beta header).
 * Flow: connect → session.created → session.update → session.updated → session.input_audio_buffer.append…
 * → session.close → session.closed → close.
 * Input must be 24 kHz PCM16 mono, so 16 kHz mic audio is upsampled here and sent in the model's 200 ms
 * frames. Output is a continuous stream of deltas with no segment events, so a segment ends here after
 * SEGMENT_QUIET_MS without output. There is no commit event and the model clock only advances with appended
 * audio, so endUtterance() appends 1.2 s of silence, then keeps appending real-time silence while the mic is
 * idle (push-to-talk released) until the segment ends or DRAIN_MAX_MS passes.
 *
 * Sources (official docs):
 * - Guide: https://developers.openai.com/api/docs/guides/realtime-translation
 * - Client events: https://developers.openai.com/api/reference/resources/realtime/translation-client-events
 * - Server events: https://developers.openai.com/api/reference/resources/realtime/translation-server-events
 * - Model: https://developers.openai.com/api/docs/models/gpt-realtime-translate
 * - Output languages, gpt-realtime-whisper: https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide
 * - No beta header on GA: https://developers.openai.com/api/docs/guides/realtime#beta-to-ga-migration
 */
import type { SpeechEngineEvents, SpeechEngineStartOptions, SpeechTranslationEngine } from './speech-engine.js';

// ── ws (no @types/ws; typed locally like qwen-livetranslate-engine.ts) ──
interface WsSocket {
  readonly readyState: number;
  send(data: string): void;
  ping(): void;
  close(code?: number): void;
  terminate(): void;
  /** Listener argument types are declared at each call site (ws 8 event signatures). */
  on(event: string, listener: (...args: never[]) => void): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws') as new (url: string, options: { headers: Record<string, string> }) => WsSocket;
type SocketError = Error & { code?: string };

/** Model id, selected through the endpoint URL's ?model= parameter. */
export const OPENAI_TRANSLATE_MODEL = 'gpt-realtime-translate';

/**
 * Output languages the model can speak (the docs list 13), as the codes the docs send in
 * audio.output.language. Exported so settings can offer only these targets for this engine.
 */
export const OPENAI_TRANSLATE_OUTPUT_LANGUAGES: readonly string[] =
  ['es', 'pt', 'fr', 'ja', 'ru', 'zh', 'de', 'ko', 'hi', 'id', 'vi', 'it', 'en'];

const ENDPOINT = `wss://api.openai.com/v1/realtime/translations?model=${OPENAI_TRANSLATE_MODEL}`;
const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper'; // enables session.input_transcript.delta
const WS_OPEN = 1;
const INPUT_RATE = 16_000; // VoiceBridge mic audio
const OUTPUT_RATE = 24_000; // session.output_audio.delta default sample_rate
const FRAME_MS = 200; // the model consumes 200 ms frames
const FRAME_SAMPLES = 4_800; // one frame at the 24 kHz the API accepts
const SILENCE_FRAME = new Int16Array((INPUT_RATE * FRAME_MS) / 1_000); // 200 ms of 16 kHz zeros
const UTTERANCE_SILENCE_FRAMES = 6; // the 1.2 s pause endUtterance() appends
const SEGMENT_QUIET_MS = 1_500; // no output for this long ends a segment
const DRAIN_MAX_MS = 8_000; // cap on real-time silence after endUtterance(); it is billed as audio
const SILENT_PEAK = 256; // a delta whose peak stays below this (about -42 dBFS) is silence
const MAX_BUFFERED_SAMPLES = INPUT_RATE * 10; // never hold more than 10 s of mic audio
const HEARTBEAT_MS = 15_000;
const SETUP_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 8_000;
const RECONNECT = { baseMs: 500, maxMs: 10_000, attempts: 5 } as const;
const STABLE_SESSION_MS = 60_000; // the reconnect budget refills only after a minute up
const API_KEY = /^[\x21-\x7e]+$/; // visible ASCII only: it goes into an HTTP header
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const OUTPUT_LANGUAGES: ReadonlySet<string> = new Set(OPENAI_TRANSLATE_OUTPUT_LANGUAGES);
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

/** Credentials and callbacks for one GPT-Realtime-Translate session. */
export interface OpenAITranslateEngineOptions {
  /** OpenAI API key. Sent only in the handshake's Authorization header. */
  apiKey: string;
  events: SpeechEngineEvents;
  /**
   * Tests only: a loopback ws:// URL used instead of the OpenAI endpoint (e.g. a local mock server).
   * SECURITY: loopback hosts only, so the API key cannot be sent anywhere else.
   */
  endpointOverride?: string;
}

type Credentials = Omit<OpenAITranslateEngineOptions, 'events'>;
interface Failure { message: string; retryable: boolean }
/** connecting: waits for session.created · configuring: for session.updated · finishing: for session.closed */
type Phase =
  | { name: 'idle' | 'finishing' | 'closed' }
  | { name: 'connecting' | 'configuring' | 'reconnecting'; attempt: number }
  | { name: 'ready'; since: number };
/** Output since the last segment end, reported in full when the segment ends. */
interface Segment { source: string; translation: string; audio: boolean }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const emptySegment = (): Segment => ({ source: '', translation: '', audio: false });
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}
function int(obj: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = obj[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function unsupportedLanguage(requested: string): Error {
  const list = OPENAI_TRANSLATE_OUTPUT_LANGUAGES.map((code) => `${LANGUAGE_NAMES.of(code) ?? code} (${code})`).join(', ');
  return new Error(`GPT-Realtime-Translate cannot speak "${requested}". Supported output languages: ${list}`);
}

/**
 * Validate the key (and the test override), then open the socket.
 * SECURITY: the key goes only into the Authorization header, never into the URL or a log line, and is
 * limited to visible ASCII so it cannot inject header lines. The override must be a loopback URL.
 */
function openSocket(c: Credentials): { ok: true; ws: WsSocket } | { ok: false; error: string } {
  const apiKey = c.apiKey.trim();
  if (!API_KEY.test(apiKey)) return { ok: false, error: 'OpenAI API key is missing or malformed' };
  if (c.endpointOverride !== undefined && !isLoopbackUrl(c.endpointOverride)) {
    return { ok: false, error: 'endpointOverride must be a loopback ws:// URL' };
  }
  try {
    const headers = { Authorization: `Bearer ${apiKey}`, 'user-agent': 'VoiceBridge-Desktop' };
    return { ok: true, ws: new WS(c.endpointOverride ?? ENDPOINT, { headers }) };
  } catch (err) {
    return { ok: false, error: `Could not open the OpenAI connection: ${errorMessage(err)}` };
  }
}

function isLoopbackUrl(url: string): boolean {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  return parsed !== null && (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && LOOPBACK_HOSTS.has(parsed.hostname);
}

function closeSocket(ws: WsSocket, graceful: boolean, log: SpeechEngineEvents['onLog']): void {
  try {
    if (graceful && ws.readyState === WS_OPEN) ws.close(1000);
    else ws.terminate();
  } catch (err) {
    log('warn', `Closing the OpenAI socket failed: ${errorMessage(err)}`);
  }
}

/** Map a rejected handshake to a user-facing message, and whether retrying could help. */
function describeHttpStatus(status: number): Failure {
  if (status === 401) return { message: 'Invalid OpenAI API key', retryable: false };
  if (status === 403 || status === 404) return { message: `This key's project cannot use ${OPENAI_TRANSLATE_MODEL} (HTTP ${status})`, retryable: false };
  if (status === 429) return { message: 'OpenAI rate limit or quota reached (HTTP 429)', retryable: true };
  return { message: `OpenAI refused the connection (HTTP ${status})`, retryable: status >= 500 };
}

const describeSocketError = (error: SocketError): string =>
  (error.code === 'ENOTFOUND' ? 'Cannot reach api.openai.com (DNS lookup failed)' : error.message);

/** SECURITY: OpenAI auth errors echo a masked key (its first 8 and last 4 characters); keep all of it out of logs and the UI. */
const redactKeys = (text: string): string => text.replace(/sk-[\w*-]+/g, 'sk-***');

function serverErrorMessage(event: Record<string, unknown>): string {
  const error = event['error'];
  return redactKeys((isRecord(error) ? str(error, 'message') : undefined) ?? 'Unknown OpenAI error');
}

function parseEvent(data: unknown): Record<string, unknown> | null {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : null;
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // the caller logs it as a non-JSON message
  }
}

/** PERF: one pass over a delta (about 4,800 samples), stopping at the first audible sample. */
function isSilent(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) >= SILENT_PEAK) return false;
  return true;
}

/**
 * Speech-to-speech translation through one GPT-Realtime-Translate session.
 * Why: one model does recognition, translation and speech in a single streaming hop, removing the
 * cascade's per-stage round-trips, and its voice follows the speaker's tone, so no voice profile is needed.
 */
export class OpenAIRealtimeTranslateEngine implements SpeechTranslationEngine {
  readonly id = 'openai-realtime-translate' as const;
  readonly #creds: Credentials;
  readonly #events: SpeechEngineEvents;
  readonly #log: SpeechEngineEvents['onLog'] = (level, message) => this.#events.onLog(level, message);
  readonly #logged = new Set<string>(); // keys of once-only log lines
  readonly #frame = new Int16Array(FRAME_SAMPLES); // 24 kHz samples collecting into one 200 ms frame
  #phase: Phase = { name: 'idle' };
  #ws: WsSocket | null = null;
  #failure: Failure | null = null; // why the current socket is going away, when known
  #targetLanguage = '';
  #pending: Int16Array[] = []; // 16 kHz mic audio held until the session is configured
  #pendingSamples = 0;
  #overflowWarned = false;
  #frameFill = 0;
  #prevSample = 0; // upsampler: last input sample of the previous chunk
  #pos3 = 0; // upsampler: next output position in thirds of an input sample; 0 is #prevSample
  #coveredUntil = 0; // wall-clock ms until which appended audio keeps the model clock running
  #segment = emptySegment();
  #segmentTimer: ReturnType<typeof setTimeout> | null = null;
  #drain: ReturnType<typeof setInterval> | null = null; // silence feed after endUtterance()
  #drainUntil = 0;
  #reconnects = 0;
  #alive = false; // heartbeat: something arrived since the last ping
  #timer: ReturnType<typeof setTimeout> | null = null; // current phase's deadline or backoff delay
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #startWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  #stopPromise: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;

  constructor(options: OpenAITranslateEngineOptions) {
    const { events, ...creds } = options;
    this.#events = events;
    this.#creds = creds;
  }

  start(options: SpeechEngineStartOptions): Promise<void> {
    if (this.#phase.name !== 'idle') return Promise.reject(new Error('OpenAI translation engine already used; create one per session'));
    // SECURITY: the code goes into the session config, so only the documented output languages pass.
    const target = options.targetLanguage.trim().toLowerCase().split(/[-_]/)[0] ?? '';
    if (!OUTPUT_LANGUAGES.has(target)) return Promise.reject(unsupportedLanguage(options.targetLanguage));
    this.#targetLanguage = target;
    if (options.sourceLanguage !== 'auto') {
      this.#events.onLog('info', `GPT-Realtime-Translate auto-detects the source language; ignoring "${options.sourceLanguage}"`);
    }
    return new Promise<void>((resolve, reject) => {
      this.#startWaiter = { resolve, reject };
      this.#connect(0);
    });
  }

  sendAudio(pcm: Int16Array): void {
    const phase = this.#phase.name;
    if (phase === 'finishing' || phase === 'closed' || pcm.length === 0) return;
    this.#coveredUntil = Math.max(this.#coveredUntil, Date.now()) + (pcm.length * 1_000) / INPUT_RATE;
    // PERF: once configured, audio goes straight out; buffering only covers setup and reconnects.
    if (phase === 'ready' && this.#pending.length === 0 && this.#append(pcm)) return;
    const copy = pcm.slice(-MAX_BUFFERED_SAMPLES);
    this.#pending.push(copy);
    this.#pendingSamples += copy.length;
    while (this.#pendingSamples > MAX_BUFFERED_SAMPLES && this.#pending.length > 1) {
      this.#pendingSamples -= this.#pending.shift()?.length ?? 0;
      if (!this.#overflowWarned) this.#events.onLog('warn', 'OpenAI session not ready: dropping the oldest buffered audio (10 s cap)');
      this.#overflowWarned = true;
    }
  }

  endUtterance(): void {
    // No commit event exists, and the model clock only moves with appended audio, which stops on a
    // push-to-talk release: mark the pause, then keep the clock running until the output is done.
    for (let i = 0; i < UTTERANCE_SILENCE_FRAMES; i++) this.sendAudio(SILENCE_FRAME);
    if (this.#phase.name !== 'ready') return;
    this.#drainUntil = Date.now() + DRAIN_MAX_MS;
    this.#drain ??= setInterval(() => this.#guard(() => this.#feedSilence()), FRAME_MS);
    this.#touchSegment();
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const phase = this.#phase.name;
    if (phase === 'closed') return Promise.resolve();
    this.#stopDrain();
    if (phase === 'ready' && this.#frameFill > 0) this.#sendFrame(); // short frame: session.close flushes it
    if (phase !== 'ready' || !this.#sendJson({ type: 'session.close' })) {
      // Not configured, mid-reconnect, or the socket is gone: no output is left to drain.
      this.#events.onLog('info', `OpenAI translation session stopped while ${phase}`);
      this.#finish(null);
      return Promise.resolve();
    }
    this.#setPhase({ name: 'finishing' }, FINISH_TIMEOUT_MS);
    this.#stopPromise = new Promise<void>((resolve) => { this.#resolveStop = resolve; });
    return this.#stopPromise;
  }

  abort(): void {
    if (this.#phase.name === 'closed') return;
    this.#teardown(false);
    this.#settle(new Error('OpenAI translation session aborted'));
  }

  #connect(attempt: number): void {
    this.#setPhase({ name: 'connecting', attempt }, SETUP_TIMEOUT_MS);
    this.#events.onStateChange({ status: 'connecting', attempt });
    const opened = openSocket(this.#creds);
    if (!opened.ok) {
      this.#finish({ message: opened.error, retryable: false });
      return;
    }
    const ws = opened.ws;
    this.#ws = ws;
    this.#failure = null;
    // Events from a socket this engine already let go of are ignored.
    const live = (fn: () => void): void => { if (ws === this.#ws) this.#guard(fn); };
    ws.on('unexpected-response', (_request: unknown, response: { statusCode?: number }) => {
      if (ws === this.#ws) this.#failure = describeHttpStatus(response.statusCode ?? 0);
      closeSocket(ws, false, this.#log);
    });
    ws.on('open', () => live(() => this.#startHeartbeat(ws)));
    ws.on('pong', () => live(() => { this.#alive = true; }));
    ws.on('message', (data: unknown) => live(() => {
      this.#alive = true;
      this.#handleEvent(data);
    }));
    ws.on('error', (error: SocketError) => live(() => {
      this.#failure ??= { message: describeSocketError(error), retryable: true };
      this.#events.onLog('warn', `OpenAI socket error: ${this.#failure.message}`);
    }));
    ws.on('close', (code: number, reason: unknown) => live(() => {
      const why = Buffer.isBuffer(reason) && reason.length > 0 ? `: ${redactKeys(reason.toString('utf8'))}` : '';
      this.#onClose(this.#failure ?? { message: `OpenAI closed the connection (code ${code}${why})`, retryable: true });
    }));
  }

  #startHeartbeat(ws: WsSocket): void {
    this.#alive = true;
    this.#heartbeat = setInterval(() => this.#guard(() => {
      if (ws !== this.#ws || ws.readyState !== WS_OPEN) return;
      if (this.#alive) {
        this.#alive = false;
        ws.ping();
        return;
      }
      this.#events.onLog('warn', 'OpenAI heartbeat: nothing received for 15 s; dropping the connection');
      ws.terminate();
    }), HEARTBEAT_MS);
  }

  #onClose(failure: Failure): void {
    this.#ws = null;
    clearInterval(this.#heartbeat ?? undefined);
    this.#endSegment(true); // a new session cannot continue this segment
    const phase = this.#phase;
    if (phase.name === 'ready') {
      this.#events.onLog('warn', `${failure.message}; reconnecting`);
      if (Date.now() - phase.since >= STABLE_SESSION_MS) this.#reconnects = 0;
      this.#scheduleReconnect(failure);
    } else if (phase.name === 'finishing') {
      this.#events.onLog('warn', `${failure.message} before session.closed`);
      this.#finish(null);
    } else if (phase.name === 'connecting' || phase.name === 'configuring') {
      if (phase.attempt > 0 && failure.retryable) this.#scheduleReconnect(failure);
      else this.#finish(failure);
    }
  }

  #scheduleReconnect(last: Failure): void {
    const attempt = ++this.#reconnects;
    if (attempt > RECONNECT.attempts) {
      this.#finish({ message: `Lost the OpenAI connection; ${RECONNECT.attempts} reconnects failed (${last.message})`, retryable: true });
      return;
    }
    const delay = Math.min(RECONNECT.baseMs * 2 ** (attempt - 1), RECONNECT.maxMs);
    this.#events.onLog('info', `OpenAI reconnect ${attempt}/${RECONNECT.attempts} in ${delay} ms`);
    this.#setPhase({ name: 'reconnecting', attempt }, delay);
    this.#events.onStateChange({ status: 'disconnected' });
  }

  /** The current phase's timer ran out: setup deadline, reconnect backoff, or finish deadline. */
  #onTimer(): void {
    const phase = this.#phase;
    if (phase.name === 'reconnecting') {
      this.#connect(phase.attempt);
    } else if (phase.name === 'finishing') {
      this.#events.onLog('warn', 'OpenAI did not confirm session.closed within 8 s; closing');
      this.#finish(null);
    } else if (this.#ws) {
      this.#failure = { message: 'Timed out waiting for the OpenAI translation session to start', retryable: true };
      this.#ws.terminate();
    }
  }

  #handleEvent(data: unknown): void {
    const event = parseEvent(data);
    if (!event) {
      this.#events.onLog('warn', 'Ignoring a non-JSON OpenAI message');
      return;
    }
    const phase = this.#phase;
    const type = str(event, 'type') ?? '';
    const delta = str(event, 'delta') ?? '';
    switch (type) {
      case 'session.created':
        if (phase.name === 'connecting' && this.#sendJson(this.#sessionUpdate())) {
          this.#setPhase({ name: 'configuring', attempt: phase.attempt }, SETUP_TIMEOUT_MS);
        }
        break;
      case 'session.updated': this.#onSessionUpdated(); break;
      // Transcript deltas are append-only fragments that carry their own spacing.
      case 'session.input_transcript.delta': this.#onText('source', delta); break;
      case 'session.output_transcript.delta': this.#onText('translation', delta); break;
      case 'session.output_audio.delta': this.#onAudioDelta(event, delta); break;
      case 'session.closed': this.#onSessionClosed(); break;
      case 'error': this.#onServerError(event); break;
      default: this.#logOnce(`type:${type}`, 'info', `Unhandled OpenAI event "${type}"`);
    }
  }

  #sessionUpdate(): Record<string, unknown> {
    // near_field noise reduction as in the docs' server example (a mic close to the speaker).
    const input = { transcription: { model: TRANSCRIPTION_MODEL }, noise_reduction: { type: 'near_field' } };
    return { type: 'session.update', session: { audio: { input, output: { language: this.#targetLanguage } } } };
  }

  #onSessionUpdated(): void {
    if (this.#phase.name !== 'configuring') return;
    this.#setPhase({ name: 'ready', since: Date.now() });
    this.#events.onStateChange({ status: 'connected' });
    while (this.#pending[0] && this.#append(this.#pending[0])) this.#pendingSamples -= this.#pending.shift()?.length ?? 0;
    this.#overflowWarned = false;
    const waiter = this.#startWaiter;
    this.#startWaiter = null;
    waiter?.resolve();
  }

  #onText(kind: 'source' | 'translation', delta: string): void {
    if (!delta) return;
    this.#segment[kind] += delta;
    if (kind === 'source') this.#events.onSourceText(delta);
    else this.#events.onTranslationText(delta);
    this.#touchSegment();
  }

  #onAudioDelta(event: Record<string, unknown>, base64: string): void {
    // The docs default format to pcm16 and channels to 1, and the session cannot request anything else.
    const format = str(event, 'format') ?? 'pcm16';
    const channels = event['channels'] ?? 1;
    const raw = format === 'pcm16' && channels === 1 ? Buffer.from(base64, 'base64') : null;
    const pcm = raw?.subarray(0, raw.length & ~1); // whole 16-bit samples only
    if (!pcm?.length) {
      this.#logOnce('audio', 'warn', `Dropping OpenAI audio deltas without mono PCM16 data (format "${format}", channels ${String(channels)})`);
      return;
    }
    const silent = isSilent(pcm);
    const segment = this.#segment;
    // Should the server also stream silent frames between phrases, they must not reopen a finished segment.
    if (silent && !segment.audio && !segment.source && !segment.translation) return;
    if (!silent) this.#touchSegment();
    segment.audio = true;
    this.#events.onAudio(pcm, int(event, 'sample_rate', 8_000, 48_000, OUTPUT_RATE));
  }

  #onSessionClosed(): void {
    if (this.#phase.name === 'finishing') {
      this.#finish(null);
    } else if (this.#ws) {
      // Not requested (e.g. the session expired): drop the socket so the close handler reconnects.
      this.#failure = { message: 'OpenAI ended the translation session', retryable: true };
      closeSocket(this.#ws, true, this.#log);
    }
  }

  #onServerError(event: Record<string, unknown>): void {
    this.#events.onLog('error', `OpenAI error: ${redactKeys(JSON.stringify(event['error'] ?? event))}`);
    // Before session.updated the error is about our configuration; resending it cannot help.
    const phase = this.#phase.name;
    if (phase === 'connecting' || phase === 'configuring') this.#finish({ message: serverErrorMessage(event), retryable: false });
  }

  /**
   * Upsample 16 kHz mic audio to the 24 kHz the API accepts and send it in whole 200 ms frames.
   * Linear interpolation at an exact 2:3 ratio: positions are integers in thirds of an input sample and
   * the previous chunk's last sample carries over, so chunk seams add no clicks or drift.
   * Returns false, consuming nothing, when the socket is not open.
   */
  #append(pcm: Int16Array): boolean {
    if (this.#ws?.readyState !== WS_OPEN) return false;
    const n = pcm.length;
    let pos3 = this.#pos3; // index 0 is #prevSample, index k is pcm[k - 1]
    // PERF: per-sample hot path; writes straight into the reused frame buffer, no allocation.
    for (; pos3 < 3 * n; pos3 += 2) {
      const i = (pos3 / 3) | 0;
      const a = i === 0 ? this.#prevSample : (pcm[i - 1] ?? 0);
      const b = pcm[i] ?? a;
      this.#frame[this.#frameFill++] = Math.round(a + ((b - a) * (pos3 - 3 * i)) / 3);
      if (this.#frameFill === FRAME_SAMPLES) this.#sendFrame();
    }
    this.#pos3 = pos3 - 3 * n;
    this.#prevSample = pcm[n - 1] ?? this.#prevSample;
    return true;
  }

  #sendFrame(): void {
    const audio = Buffer.from(this.#frame.buffer, this.#frame.byteOffset, this.#frameFill * 2).toString('base64');
    this.#frameFill = 0;
    this.#sendJson({ type: 'session.input_audio_buffer.append', audio });
  }

  #sendJson(message: Record<string, unknown>): boolean {
    if (this.#ws?.readyState !== WS_OPEN) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  /** Timer tick after endUtterance(): append 200 ms of silence whenever no audio covers the model clock. */
  #feedSilence(): void {
    const now = Date.now();
    if (this.#phase.name !== 'ready' || now >= this.#drainUntil) this.#stopDrain();
    else if (now >= this.#coveredUntil - FRAME_MS) this.sendAudio(SILENCE_FRAME);
  }

  #stopDrain(): void {
    clearInterval(this.#drain ?? undefined);
    this.#drain = null;
  }

  /** Re-arm the end-of-segment timer: the API has no segment events, so a pause in output ends one. */
  #touchSegment(): void {
    clearTimeout(this.#segmentTimer ?? undefined);
    this.#segmentTimer = setTimeout(() => this.#guard(() => this.#endSegment(true)), SEGMENT_QUIET_MS);
  }

  /** Close the current segment and stop feeding silence; `emit` reports it in full (false: teardown). */
  #endSegment(emit: boolean): void {
    clearTimeout(this.#segmentTimer ?? undefined);
    this.#segmentTimer = null;
    this.#stopDrain();
    const { source, translation, audio } = this.#segment;
    this.#segment = emptySegment();
    if (!emit) return;
    if (source.trim()) this.#events.onSourceFinal(source.trim());
    if (translation.trim()) this.#events.onTranslationFinal(translation.trim());
    if (audio) this.#events.onAudioDone();
  }

  /** End the session (`null` = graceful stop), report the final state, settle pending start()/stop(). */
  #finish(failure: Failure | null): void {
    if (failure) this.#events.onLog('error', `OpenAI translation session failed: ${failure.message}`);
    this.#endSegment(true);
    this.#teardown(failure === null);
    this.#events.onStateChange(failure ? { status: 'error', error: failure.message, retryable: failure.retryable } : { status: 'disconnected' });
    this.#settle(new Error(failure?.message ?? 'OpenAI translation session stopped before it was ready'));
  }

  /** Reject a pending start() with `startError` and resolve a pending stop(). */
  #settle(startError: Error): void {
    const waiter = this.#startWaiter;
    const resolveStop = this.#resolveStop;
    this.#startWaiter = null;
    this.#resolveStop = null;
    waiter?.reject(startError);
    resolveStop?.();
  }

  /** Release the socket, timers and buffered audio without emitting events. */
  #teardown(graceful: boolean): void {
    this.#setPhase({ name: 'closed' });
    clearInterval(this.#heartbeat ?? undefined);
    this.#endSegment(false);
    this.#pending = [];
    this.#pendingSamples = 0;
    this.#frameFill = 0;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) closeSocket(ws, graceful, this.#log);
  }

  #setPhase(next: Phase, timeoutMs?: number): void {
    if (next.name !== this.#phase.name) this.#events.onLog('info', `OpenAI engine ${this.#phase.name} → ${next.name}`);
    this.#phase = next;
    clearTimeout(this.#timer ?? undefined);
    this.#timer = timeoutMs === undefined ? null : setTimeout(() => this.#guard(() => this.#onTimer()), timeoutMs);
  }

  #logOnce(key: string, level: 'info' | 'warn', message: string): void {
    if (this.#logged.has(key)) return;
    this.#logged.add(key);
    this.#events.onLog(level, message);
  }

  /** Socket and timer callbacks run outside any caller's try/catch; a throwing callback must not crash main. */
  #guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#events.onLog('error', `OpenAI engine callback failed: ${errorMessage(err)}`);
    }
  }
}

/**
 * Check an API key by opening a translation session, waiting for session.created, then closing it.
 * Why a real session: the handshake is exactly what fails on a wrong key or on a project without access
 * to the model, so one round-trip checks both. No audio is sent.
 */
export function validateOpenAITranslateCredentials(params: { apiKey: string }): Promise<{ valid: boolean; error?: string }> {
  return new Promise((resolve) => {
    const opened = openSocket({ apiKey: params.apiKey });
    if (!opened.ok) {
      resolve({ valid: false, error: opened.error });
      return;
    }
    const { ws } = opened;
    let done = false;
    const finish = (result: { valid: boolean; error?: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeSocket(ws, true, (_level, message) => console.warn(`[openai-translate] ${message}`));
      resolve(result);
    };
    const timer = setTimeout(() => finish({ valid: false, error: 'Timed out connecting to OpenAI (10 s)' }), SETUP_TIMEOUT_MS);
    ws.on('unexpected-response', (_request: unknown, response: { statusCode?: number }) =>
      finish({ valid: false, error: describeHttpStatus(response.statusCode ?? 0).message }));
    ws.on('error', (error: SocketError) => finish({ valid: false, error: describeSocketError(error) }));
    ws.on('close', (code: number) => finish({ valid: false, error: `OpenAI closed the connection (code ${code})` }));
    ws.on('message', (data: unknown) => {
      const event = parseEvent(data);
      const type = event ? str(event, 'type') : undefined;
      if (type === 'session.created') finish({ valid: true });
      else if (event && type === 'error') finish({ valid: false, error: serverErrorMessage(event) });
    });
  });
}
