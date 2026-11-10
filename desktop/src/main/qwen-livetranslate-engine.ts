/**
 * Qwen3.8 LiveTranslate engine (Alibaba Cloud Model Studio realtime WebSocket API).
 * Flow: connect → session.created → session.update → session.updated → input_audio_buffer.append…
 * → session.finish → session.finished → close. The server segments speech itself
 * (speaker_detection), so there is no commit event; endUtterance() pads silence instead.
 */
import type { QwenRegion } from '../shared/types.js';
import type { SpeechEngineEvents, SpeechEngineStartOptions, SpeechTranslationEngine } from './speech-engine.js';

// ── ws (no @types/ws; typed locally like desktop-pipeline.ts) ──
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

/** Model id, selected through the session URL's ?model= parameter. */
export const QWEN_LIVETRANSLATE_MODEL = 'qwen3.8-livetranslate-flash-realtime';

const WS_OPEN = 1;
const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000; // response.audio.delta: PCM s16le mono
const MAX_BUFFERED_SAMPLES = INPUT_RATE * 10; // never hold more than 10 s of mic audio
const SILENCE_CHUNK = new Int16Array(INPUT_RATE / 4); // 250 ms of zeros
const SILENCE_CHUNKS = 5; // 1.25 s outlasts the server's 1000 ms end-of-segment silence
const HEARTBEAT_MS = 15_000;
const SETUP_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 8_000;
const RECONNECT = { baseMs: 500, maxMs: 10_000, attempts: 5 } as const;
const STABLE_SESSION_MS = 60_000; // the reconnect budget refills only after a minute up (10 requests/min limit)
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const API_KEY = /^[\x21-\x7e]+$/; // visible ASCII only: it goes into an HTTP header
const REGIONS: ReadonlySet<string> = new Set(['ap-southeast-1', 'cn-beijing'] satisfies QwenRegion[]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Credentials and callbacks for one Qwen LiveTranslate session. */
export interface QwenEngineOptions {
  apiKey: string;
  /** Model Studio workspace ID; it becomes part of the endpoint hostname. */
  workspaceId: string;
  region: QwenRegion;
  events: SpeechEngineEvents;
  /**
   * Tests only: a ws:// URL used instead of the Model Studio endpoint (e.g. a local mock server).
   * SECURITY: loopback hosts only, so the API key cannot be sent anywhere else.
   */
  endpointOverride?: string;
}

type Credentials = Omit<QwenEngineOptions, 'events'>;
interface Failure { message: string; retryable: boolean }
/** connecting: waits for session.created · configuring: for session.updated · finishing: for session.finished */
type Phase =
  | { name: 'idle' | 'finishing' | 'closed' }
  | { name: 'connecting' | 'configuring' | 'reconnecting'; attempt: number }
  | { name: 'ready'; since: number };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate credentials, then open the socket.
 * SECURITY: workspaceId is interpolated into the hostname that receives the API key, and region comes
 * from editable settings, so both are checked strictly first. The key goes only into the
 * Authorization header, never into the URL or a log line.
 */
function openSocket(c: Credentials): { ok: true; ws: WsSocket } | { ok: false; error: string } {
  const apiKey = c.apiKey.trim();
  const workspaceId = c.workspaceId.trim();
  if (!API_KEY.test(apiKey)) return { ok: false, error: 'Qwen API key is missing or malformed' };
  if (c.endpointOverride === undefined) {
    if (!WORKSPACE_ID.test(workspaceId)) return { ok: false, error: 'Workspace ID is invalid (letters, digits and hyphens only)' };
    if (!REGIONS.has(c.region)) return { ok: false, error: 'Unsupported Qwen region (use ap-southeast-1 or cn-beijing)' };
  } else if (!isLoopbackUrl(c.endpointOverride)) {
    return { ok: false, error: 'endpointOverride must be a loopback ws:// URL' };
  }
  const url = c.endpointOverride
    ?? `wss://${workspaceId}.${c.region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${QWEN_LIVETRANSLATE_MODEL}`;
  try {
    return { ok: true, ws: new WS(url, { headers: { Authorization: `Bearer ${apiKey}`, 'user-agent': 'VoiceBridge-Desktop' } }) };
  } catch (err) {
    return { ok: false, error: `Could not open the Qwen connection: ${errorMessage(err)}` };
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
    log('warn', `Closing the Qwen socket failed: ${errorMessage(err)}`);
  }
}

/** Map a rejected handshake to a user-facing message, and whether retrying could help. */
function describeHttpStatus(status: number): Failure {
  if (status === 401 || status === 403) return { message: 'Invalid API key or workspace', retryable: false };
  if (status !== 404) return { message: `Qwen refused the connection (HTTP ${status})`, retryable: status === 429 || status >= 500 };
  return { message: `Workspace or model not found in this region (activate ${QWEN_LIVETRANSLATE_MODEL} in Model Studio)`, retryable: false };
}

/** ENOTFOUND: DNS has no {workspace}.{region} host, so one of the two is wrong. */
const describeSocketError = (error: SocketError): string =>
  (error.code === 'ENOTFOUND' ? 'Workspace ID or region is wrong' : error.message);

function serverErrorMessage(event: Record<string, unknown>): string {
  const error = event['error'];
  return (isRecord(error) ? str(error, 'message') : undefined) ?? 'Unknown Qwen error';
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

/**
 * The docs' sample audio delta is base64 WAV ("UklGR…" = "RIFF") although the stream is raw PCM.
 * Accept both: skip a RIFF header through the `data` sub-chunk header and honour its sample rate.
 */
function decodeAudioDelta(base64: string): { pcm: Buffer; sampleRate: number } | null {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF') return { pcm: buf, sampleRate: OUTPUT_RATE };
  let sampleRate = OUTPUT_RATE;
  for (let offset = 12; offset + 8 <= buf.length;) { // skip "RIFF" <size> "WAVE"
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return { pcm: buf.subarray(offset + 8), sampleRate };
    const rate = id === 'fmt ' && offset + 16 <= buf.length ? buf.readUInt32LE(offset + 12) : 0;
    if (rate >= 8_000 && rate <= 48_000) sampleRate = rate;
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/**
 * Speech-to-speech translation through one Qwen3.8 LiveTranslate session.
 * Why: one model does STT, translation and TTS in a single hop, removing the cascade's per-stage
 * round-trips, and it clones the speaker's voice itself, so no ElevenLabs voice profile is needed.
 */
export class QwenLiveTranslateEngine implements SpeechTranslationEngine {
  readonly id = 'qwen-livetranslate' as const;
  readonly #creds: Credentials;
  readonly #events: SpeechEngineEvents;
  readonly #unknownTypes = new Set<string>();
  #phase: Phase = { name: 'idle' };
  #ws: WsSocket | null = null;
  #failure: Failure | null = null; // why the current socket is going away, when known
  #targetLanguage = '';
  #pending: Int16Array[] = []; // mic audio held until the session is configured
  #pendingSamples = 0;
  #overflowWarned = false;
  #reconnects = 0;
  #audioInFlight = false;
  #alive = false; // heartbeat: something arrived since the last ping
  #timer: ReturnType<typeof setTimeout> | null = null; // current phase's deadline or backoff delay
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #startWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  #stopPromise: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;

  constructor(options: QwenEngineOptions) {
    const { events, ...creds } = options;
    this.#events = events;
    this.#creds = creds;
  }

  start(options: SpeechEngineStartOptions): Promise<void> {
    if (this.#phase.name !== 'idle') return Promise.reject(new Error('Qwen engine already used; create one per session'));
    this.#targetLanguage = options.targetLanguage.trim();
    if (!this.#targetLanguage) return Promise.reject(new Error('Target language is required'));
    if (options.sourceLanguage !== 'auto') {
      this.#events.onLog('info', `Qwen3.8 LiveTranslate auto-detects the source language; ignoring "${options.sourceLanguage}"`);
    }
    return new Promise<void>((resolve, reject) => {
      this.#startWaiter = { resolve, reject };
      this.#connect(0);
    });
  }

  sendAudio(pcm: Int16Array): void {
    const phase = this.#phase.name;
    if (phase === 'finishing' || phase === 'closed' || pcm.length === 0) return;
    // PERF: once configured, audio goes straight out; buffering only covers setup and reconnects.
    if (phase === 'ready' && this.#pending.length === 0 && this.#append(pcm)) return;
    const copy = pcm.slice(-MAX_BUFFERED_SAMPLES);
    this.#pending.push(copy);
    this.#pendingSamples += copy.length;
    while (this.#pendingSamples > MAX_BUFFERED_SAMPLES && this.#pending.length > 1) {
      this.#pendingSamples -= this.#pending.shift()?.length ?? 0;
      if (!this.#overflowWarned) this.#events.onLog('warn', 'Qwen session not ready: dropping the oldest buffered audio (10 s cap)');
      this.#overflowWarned = true;
    }
  }

  endUtterance(): void {
    // The server closes a segment after 1000 ms of silence, which a push-to-talk release never sends.
    for (let i = 0; i < SILENCE_CHUNKS; i++) this.sendAudio(SILENCE_CHUNK);
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const phase = this.#phase.name;
    if (phase === 'closed') return Promise.resolve();
    if (phase !== 'ready' || !this.#sendJson({ type: 'session.finish' })) {
      // Not configured, mid-reconnect, or the socket is gone: no output is left to drain.
      this.#events.onLog('info', `Qwen session stopped while ${phase}`);
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
    this.#settle(new Error('Qwen session aborted'));
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
      closeSocket(ws, false, (level, message) => this.#events.onLog(level, message));
    });
    ws.on('open', () => live(() => this.#startHeartbeat(ws)));
    ws.on('pong', () => live(() => { this.#alive = true; }));
    ws.on('message', (data: unknown) => live(() => {
      this.#alive = true;
      this.#handleEvent(data);
    }));
    ws.on('error', (error: SocketError) => live(() => {
      this.#failure ??= { message: describeSocketError(error), retryable: true };
      this.#events.onLog('warn', `Qwen socket error: ${this.#failure.message}`);
    }));
    ws.on('close', (code: number, reason: unknown) => live(() => {
      const why = Buffer.isBuffer(reason) && reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
      this.#onClose(this.#failure ?? { message: `Qwen closed the connection (code ${code}${why})`, retryable: true });
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
      this.#events.onLog('warn', 'Qwen heartbeat: nothing received for 15 s; dropping the connection');
      ws.terminate();
    }), HEARTBEAT_MS);
  }

  #onClose(failure: Failure): void {
    this.#ws = null;
    clearInterval(this.#heartbeat ?? undefined);
    this.#flushAudioDone();
    const phase = this.#phase;
    if (phase.name === 'ready') {
      this.#events.onLog('warn', `${failure.message}; reconnecting`);
      if (Date.now() - phase.since >= STABLE_SESSION_MS) this.#reconnects = 0;
      this.#scheduleReconnect(failure);
    } else if (phase.name === 'finishing') {
      this.#events.onLog('warn', `${failure.message} before session.finished`);
      this.#finish(null);
    } else if (phase.name === 'connecting' || phase.name === 'configuring') {
      if (phase.attempt > 0 && failure.retryable) this.#scheduleReconnect(failure);
      else this.#finish(failure);
    }
  }

  #scheduleReconnect(last: Failure): void {
    const attempt = ++this.#reconnects;
    if (attempt > RECONNECT.attempts) {
      this.#finish({ message: `Lost the Qwen connection; ${RECONNECT.attempts} reconnects failed (${last.message})`, retryable: true });
      return;
    }
    const delay = Math.min(RECONNECT.baseMs * 2 ** (attempt - 1), RECONNECT.maxMs);
    this.#events.onLog('info', `Qwen reconnect ${attempt}/${RECONNECT.attempts} in ${delay} ms`);
    this.#setPhase({ name: 'reconnecting', attempt }, delay);
    this.#events.onStateChange({ status: 'disconnected' });
  }

  /** The current phase's timer ran out: setup deadline, reconnect backoff, or finish deadline. */
  #onTimer(): void {
    const phase = this.#phase;
    if (phase.name === 'reconnecting') {
      this.#connect(phase.attempt);
    } else if (phase.name === 'finishing') {
      this.#events.onLog('warn', 'Qwen did not confirm session.finished within 8 s; closing');
      this.#finish(null);
    } else if (this.#ws) {
      this.#failure = { message: 'Timed out waiting for the Qwen session to start', retryable: true };
      this.#ws.terminate();
    }
  }

  #handleEvent(data: unknown): void {
    const event = parseEvent(data);
    if (!event) {
      this.#events.onLog('warn', 'Ignoring a non-JSON Qwen message');
      return;
    }
    const events = this.#events;
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
      case 'conversation.item.input_audio_transcription.delta': if (delta) events.onSourceText(delta); break;
      case 'conversation.item.input_audio_transcription.completed': events.onSourceFinal(str(event, 'transcript') ?? ''); break;
      case 'response.audio_transcript.delta':
      case 'response.text.delta': if (delta) events.onTranslationText(delta); break;
      case 'response.audio_transcript.done':
      case 'response.text.done': events.onTranslationFinal(str(event, 'transcript') ?? str(event, 'text') ?? ''); break;
      case 'response.audio.delta': this.#onAudioDelta(delta); break;
      case 'response.audio.done': // also sent when a response is interrupted
        this.#audioInFlight = false;
        events.onAudioDone();
        break;
      case 'input_audio_buffer.speech_started':
      case 'input_audio_buffer.speech_stopped': events.onLog('info', `Qwen ${type}`); break;
      case 'session.finished':
        if (phase.name === 'finishing') this.#finish(null);
        else events.onLog('warn', 'Qwen finished the session unexpectedly');
        break;
      case 'error': this.#onServerError(event); break;
      default:
        if (this.#unknownTypes.has(type)) break;
        this.#unknownTypes.add(type);
        events.onLog('info', `Unhandled Qwen event "${type}"`);
    }
  }

  #sessionUpdate(): Record<string, unknown> {
    return {
      type: 'session.update',
      session: {
        output_modalities: ['text', 'audio'],
        audio: { input: { format: { type: 'pcm', sample_rate: INPUT_RATE }, turn_detection: { type: 'speaker_detection', threshold: 0.5 } } },
        voice: 'default', // required when voice_clone_options.frequency is "once" or "always"
        enable_voice_clone: true,
        voice_clone_options: { frequency: 'once' }, // clone the single speaker once, at session start
        translation: { language: this.#targetLanguage },
      },
    };
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

  #onAudioDelta(base64: string): void {
    const audio = base64 ? decodeAudioDelta(base64) : null;
    if (!audio) {
      this.#events.onLog('warn', 'Dropped a Qwen audio chunk without PCM data');
    } else if (audio.pcm.length > 0) {
      this.#audioInFlight = true;
      this.#events.onAudio(audio.pcm, audio.sampleRate);
    }
  }

  #onServerError(event: Record<string, unknown>): void {
    this.#events.onLog('error', `Qwen error: ${JSON.stringify(event['error'] ?? event)}`);
    // Before session.updated the error is about our configuration; resending it cannot help.
    const phase = this.#phase.name;
    if (phase === 'connecting' || phase === 'configuring') this.#finish({ message: serverErrorMessage(event), retryable: false });
  }

  #append(pcm: Int16Array): boolean {
    const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    return this.#sendJson({ type: 'input_audio_buffer.append', audio });
  }

  #sendJson(message: Record<string, unknown>): boolean {
    if (this.#ws?.readyState !== WS_OPEN) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  /** A response cut off mid-audio never sends response.audio.done; tell the pipeline anyway. */
  #flushAudioDone(): void {
    if (!this.#audioInFlight) return;
    this.#audioInFlight = false;
    this.#events.onAudioDone();
  }

  /** End the session (`null` = graceful stop), report the final state, settle pending start()/stop(). */
  #finish(failure: Failure | null): void {
    if (failure) this.#events.onLog('error', `Qwen session failed: ${failure.message}`);
    this.#flushAudioDone();
    this.#teardown(failure === null);
    this.#events.onStateChange(failure ? { status: 'error', error: failure.message, retryable: failure.retryable } : { status: 'disconnected' });
    this.#settle(new Error(failure?.message ?? 'Qwen session stopped before it was ready'));
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
    this.#pending = [];
    this.#pendingSamples = 0;
    this.#audioInFlight = false;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) closeSocket(ws, graceful, (level, message) => this.#events.onLog(level, message));
  }

  #setPhase(next: Phase, timeoutMs?: number): void {
    if (next.name !== this.#phase.name) this.#events.onLog('info', `Qwen engine ${this.#phase.name} → ${next.name}`);
    this.#phase = next;
    clearTimeout(this.#timer ?? undefined);
    this.#timer = timeoutMs === undefined ? null : setTimeout(() => this.#guard(() => this.#onTimer()), timeoutMs);
  }

  /** Socket and timer callbacks run outside any caller's try/catch; a throwing callback must not crash main. */
  #guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#events.onLog('error', `Qwen engine callback failed: ${errorMessage(err)}`);
    }
  }
}

/**
 * Check credentials by opening a session, waiting for session.created, then closing it.
 * Why a real session: the handshake is exactly what fails on a wrong key, workspace or region, or on
 * a model that is not activated in the workspace, so one round-trip checks all of them.
 */
export function validateQwenCredentials(params: Omit<QwenEngineOptions, 'events'>): Promise<{ valid: boolean; error?: string }> {
  return new Promise((resolve) => {
    const opened = openSocket(params);
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
      closeSocket(ws, true, (_level, message) => console.warn(`[qwen] ${message}`));
      resolve(result);
    };
    const timer = setTimeout(() => finish({ valid: false, error: 'Timed out connecting to Qwen (10 s)' }), SETUP_TIMEOUT_MS);
    ws.on('unexpected-response', (_request: unknown, response: { statusCode?: number }) =>
      finish({ valid: false, error: describeHttpStatus(response.statusCode ?? 0).message }));
    ws.on('error', (error: SocketError) => finish({ valid: false, error: describeSocketError(error) }));
    ws.on('close', (code: number) => finish({ valid: false, error: `Qwen closed the connection (code ${code})` }));
    ws.on('message', (data: unknown) => {
      const event = parseEvent(data);
      const type = event ? str(event, 'type') : undefined;
      if (type === 'session.created') finish({ valid: true });
      else if (event && type === 'error') finish({ valid: false, error: serverErrorMessage(event) });
    });
  });
}
