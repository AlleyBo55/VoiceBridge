/**
 * Gemini 3.5 Live Translate engine (Gemini Live API, raw BidiGenerateContent WebSocket).
 * Flow: connect → setup → setupComplete → realtimeInput.audio… → serverContent (input/outputTranscription,
 * modelTurn audio, generationComplete, turnComplete) → close. The server segments speech itself;
 * endUtterance() and stop() send realtimeInput.audioStreamEnd, the documented flush for a paused mic.
 * A connection lasts ~10 min: on goAway the open turn drains, then a fresh session takes over.
 *
 * Official docs: https://aistudio.google.com/docs/live-api/live-translate (setup, audio formats),
 * https://aistudio.google.com/docs/models/gemini-3.5-live-translate-preview,
 * https://aistudio.google.com/api-reference/live/bidi-generate-content (endpoint),
 * https://aistudio.google.com/api-reference/live (setup, realtimeInput, serverContent and goAway schemas),
 * https://aistudio.google.com/api-reference (x-goog-api-key auth, listed for wss://…/ws/… too),
 * https://aistudio.google.com/docs/live-api/capabilities (audioStreamEnd as an immediate flush),
 * https://aistudio.google.com/docs/live-api/session-management (connection lifetime, goAway).
 * The guide's raw-WebSocket sample nests input/outputAudioTranscription in generationConfig; the
 * BidiGenerateContentSetup schema puts them on setup, which is used here. Session resumption is not
 * documented for this model and translation needs no history, so every connection is a fresh session.
 */
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

/** Model id, sent as setup.model = "models/<id>". */
export const GEMINI_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const WS_OPEN = 1;
const INPUT_MIME = 'audio/pcm;rate=16000'; // mic audio: PCM s16le mono 16 kHz
const OUTPUT_RATE = 24_000; // documented output rate; a rate in the part's mimeType wins
const MAX_BUFFERED_SAMPLES = 16_000 * 10; // never hold more than 10 s of mic audio
const HEARTBEAT_MS = 15_000;
const SETUP_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 8_000;
const FINISH_QUIET_MS = 2_000; // after audioStreamEnd, a server with no open turn that stays quiet this long is done
const GOAWAY_MARGIN_MS = 1_000; // switch sessions this long before goAway.timeLeft runs out
const RECONNECT = { baseMs: 500, maxMs: 10_000, attempts: 5 } as const;
const STABLE_SESSION_MS = 60_000; // the reconnect budget refills only after a minute up
const API_KEY = /^[\x21-\x7e]+$/; // visible ASCII only: it goes into an HTTP header
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The app's language list uses bare zh/pt; Live Translate documents only script or region variants of them. */
const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([['zh', 'zh-Hans'], ['pt', 'pt-BR']]);
const AUDIO_STREAM_END = { realtimeInput: { audioStreamEnd: true } } as const;

/** Credentials and callbacks for one Gemini Live Translate session. */
export interface GeminiTranslateEngineOptions {
  apiKey: string;
  events: SpeechEngineEvents;
  /**
   * Tests only: a loopback ws:// URL used instead of the Gemini endpoint (e.g. a local mock server).
   * SECURITY: loopback hosts only, so the API key cannot be sent anywhere else.
   */
  endpointOverride?: string;
}

type Credentials = Omit<GeminiTranslateEngineOptions, 'events'>;
interface Failure { message: string; retryable: boolean }
/** configuring: setup sent, waiting for setupComplete · rotating: draining the open turn after goAway */
type Phase =
  | { name: 'idle' | 'closed' }
  | { name: 'connecting' | 'configuring' | 'reconnecting'; attempt: number }
  | { name: 'ready' | 'rotating'; since: number }
  | { name: 'finishing'; deadline: number };
/** What the server produced for the open turn; `open`: it heard speech or sent output since turnComplete. */
interface Turn { source: string; translation: string; audioInFlight: boolean; open: boolean }
const newTurn = (): Turn => ({ source: '', translation: '', audioInFlight: false, open: false });

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}
/** Text of a BidiGenerateContentTranscription ({ text, languageCode }), or '' when absent. */
const transcript = (value: unknown): string => (isRecord(value) ? str(value, 'text') ?? '' : '');
/** google.protobuf.Duration in its JSON form, e.g. "9.5s". */
function durationMs(value: unknown): number | null {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  return match?.[1] === undefined ? null : Math.round(Number(match[1]) * 1000);
}
/** Sample rate from an inline-data mimeType such as "audio/pcm;rate=24000". */
function audioRate(mimeType: string | undefined): number {
  const rate = Number(/rate=(\d+)/.exec(mimeType ?? '')?.[1]);
  return rate >= 8_000 && rate <= 48_000 ? rate : OUTPUT_RATE;
}

/**
 * The first client message. The model takes no tools or instructions, only TranslationConfig and the
 * transcription switches. echoTargetLanguage: VoiceBridge replaces the user's mic, so speech already in
 * the target language must still reach the meeting instead of going silent.
 */
function setupMessage(targetLanguageCode: string): Record<string, unknown> {
  return {
    setup: {
      model: `models/${GEMINI_TRANSLATE_MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode, echoTargetLanguage: true } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

/**
 * Validate the key and the override, then open the socket.
 * SECURITY: the key travels only in the x-goog-api-key handshake header, never in the URL, so no logged
 * URL or error can carry it. The visible-ASCII check also blocks header injection.
 */
function openSocket(c: Credentials): { ok: true; ws: WsSocket } | { ok: false; error: string } {
  const apiKey = c.apiKey.trim();
  if (!API_KEY.test(apiKey)) return { ok: false, error: 'Gemini API key is missing or malformed' };
  if (c.endpointOverride !== undefined && !isLoopbackUrl(c.endpointOverride)) {
    return { ok: false, error: 'endpointOverride must be a loopback ws:// URL' };
  }
  try {
    const headers = { 'x-goog-api-key': apiKey, 'user-agent': 'VoiceBridge-Desktop' };
    return { ok: true, ws: new WS(c.endpointOverride ?? ENDPOINT, { headers }) };
  } catch (err) {
    return { ok: false, error: `Could not open the Gemini connection: ${errorMessage(err)}` };
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
    log('warn', `Closing the Gemini socket failed: ${errorMessage(err)}`);
  }
}

/** Map a rejected handshake to a user-facing message, and whether retrying could help. */
function describeHttpStatus(status: number): Failure {
  // Google APIs answer an invalid key with 400 (API_KEY_INVALID) as well as 401/403.
  if (status === 400 || status === 401 || status === 403) return { message: 'Invalid Gemini API key, or the key cannot use the Live API', retryable: false };
  if (status === 404) return { message: 'Gemini Live endpoint not found', retryable: false };
  return { message: `Gemini refused the connection (HTTP ${status})`, retryable: status === 429 || status >= 500 };
}

const describeSocketError = (error: SocketError): string =>
  (error.code === 'ENOTFOUND' ? 'Cannot resolve generativelanguage.googleapis.com; check the network' : error.message);

/**
 * The Live API has no error message type: it reports failures in the close frame. Per RFC 6455, 1007
 * (invalid payload) and 1008 (policy violation: bad key, model access) mean resending cannot help.
 */
function describeClose(code: number, reason: unknown): Failure {
  const why = Buffer.isBuffer(reason) && reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
  return { message: `Gemini closed the connection (code ${code}${why})`, retryable: code !== 1007 && code !== 1008 };
}

/** Server messages are JSON, in text or binary frames. */
function parseMessage(data: unknown): Record<string, unknown> | null {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : null;
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // the caller logs it as a non-JSON message
  }
}

/**
 * Speech-to-speech translation through one Gemini 3.5 Live Translate session.
 * Why: one model does STT, translation and TTS in a single hop, removing the cascade's per-stage
 * round-trips, and it keeps the speaker's intonation, pacing and pitch without a cloned voice profile.
 */
export class GeminiLiveTranslateEngine implements SpeechTranslationEngine {
  readonly id = 'gemini-live-translate' as const;
  readonly #creds: Credentials;
  readonly #events: SpeechEngineEvents;
  readonly #log: SpeechEngineEvents['onLog'] = (level, message) => this.#events.onLog(level, message);
  readonly #loggedFields = new Set(['usageMetadata', 'voiceActivity']); // unhandled fields are logged once; these are noise
  #phase: Phase = { name: 'idle' };
  #ws: WsSocket | null = null;
  #failure: Failure | null = null; // why the current socket is going away, when known
  #targetLanguage = '';
  #pending: (Int16Array | null)[] = []; // mic audio held until setupComplete; null = a queued audioStreamEnd
  #pendingSamples = 0;
  #overflowWarned = false;
  #reconnects = 0;
  #turn = newTurn();
  #alive = false; // heartbeat: something arrived since the last ping
  #timer: ReturnType<typeof setTimeout> | null = null; // current phase's deadline, backoff or drain delay
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #startWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  #stopPromise: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;

  constructor(options: GeminiTranslateEngineOptions) {
    const { events, ...creds } = options;
    this.#events = events;
    this.#creds = creds;
  }

  start(options: SpeechEngineStartOptions): Promise<void> {
    if (this.#phase.name !== 'idle') return Promise.reject(new Error('Gemini engine already used; create one per session'));
    const target = options.targetLanguage.trim();
    this.#targetLanguage = LANGUAGE_ALIASES.get(target.toLowerCase()) ?? target;
    if (!this.#targetLanguage) return Promise.reject(new Error('Target language is required'));
    if (options.sourceLanguage !== 'auto') {
      this.#log('info', `Gemini Live Translate auto-detects the source language; ignoring "${options.sourceLanguage}"`);
    }
    return new Promise<void>((resolve, reject) => {
      this.#startWaiter = { resolve, reject };
      this.#connect(0);
    });
  }

  sendAudio(pcm: Int16Array): void {
    const phase = this.#phase.name;
    if (phase === 'finishing' || phase === 'closed' || pcm.length === 0) return;
    // PERF: once set up, audio goes straight out; buffering only covers setup, session switches and reconnects.
    if (phase === 'ready' && this.#pending.length === 0 && this.#append(pcm)) return;
    const copy = pcm.slice(-MAX_BUFFERED_SAMPLES);
    this.#pending.push(copy);
    this.#pendingSamples += copy.length;
    while (this.#pendingSamples > MAX_BUFFERED_SAMPLES && this.#pending.length > 1) {
      this.#pendingSamples -= this.#pending.shift()?.length ?? 0;
      if (!this.#overflowWarned) this.#log('warn', 'Gemini session not ready: dropping the oldest buffered audio (10 s cap)');
      this.#overflowWarned = true;
    }
  }

  endUtterance(): void {
    const phase = this.#phase.name;
    if (phase === 'finishing' || phase === 'closed') return;
    // audioStreamEnd makes the server finalize now instead of waiting for silence a released key never sends.
    if (phase === 'ready' && this.#pending.length === 0 && this.#sendJson(AUDIO_STREAM_END)) return;
    if (this.#pending.at(-1) !== null) this.#pending.push(null); // replayed in order once a session is ready
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const phase = this.#phase.name;
    if (phase === 'closed') return Promise.resolve();
    if ((phase !== 'ready' && phase !== 'rotating') || !this.#sendJson(AUDIO_STREAM_END)) {
      // Not set up, mid-reconnect, or the socket is gone: no output is left to drain.
      this.#log('info', `Gemini session stopped while ${phase}`);
      this.#finish(null);
      return Promise.resolve();
    }
    this.#setPhase({ name: 'finishing', deadline: Date.now() + FINISH_TIMEOUT_MS }, FINISH_QUIET_MS);
    this.#stopPromise = new Promise<void>((resolve) => { this.#resolveStop = resolve; });
    return this.#stopPromise;
  }

  abort(): void {
    if (this.#phase.name === 'closed') return;
    this.#teardown(false);
    this.#settle(new Error('Gemini session aborted'));
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
    ws.on('open', () => live(() => {
      this.#startHeartbeat(ws);
      const phase = this.#phase;
      if (phase.name === 'connecting' && this.#sendJson(setupMessage(this.#targetLanguage))) {
        this.#setPhase({ name: 'configuring', attempt: phase.attempt }, SETUP_TIMEOUT_MS);
      }
    }));
    ws.on('pong', () => live(() => { this.#alive = true; }));
    ws.on('message', (data: unknown) => live(() => {
      this.#alive = true;
      this.#handleMessage(data);
    }));
    ws.on('error', (error: SocketError) => live(() => {
      this.#failure ??= { message: describeSocketError(error), retryable: true };
      this.#log('warn', `Gemini socket error: ${this.#failure.message}`);
    }));
    ws.on('close', (code: number, reason: unknown) => live(() => this.#onClose(this.#failure ?? describeClose(code, reason))));
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
      this.#log('warn', 'Gemini heartbeat: nothing received for 15 s; dropping the connection');
      ws.terminate();
    }), HEARTBEAT_MS);
  }

  #onClose(failure: Failure): void {
    this.#ws = null;
    clearInterval(this.#heartbeat ?? undefined);
    this.#flushTurn(); // a turn cut off with its socket never gets turnComplete
    const phase = this.#phase;
    if (phase.name === 'ready') {
      this.#log('warn', `${failure.message}; reconnecting`);
      if (Date.now() - phase.since >= STABLE_SESSION_MS) this.#reconnects = 0;
      this.#scheduleReconnect(failure);
    } else if (phase.name === 'rotating') {
      this.#rotate(phase.since); // the server closed first, as its goAway announced
    } else if (phase.name === 'finishing') {
      this.#log('warn', `${failure.message} before the last turn completed`);
      this.#finish(null);
    } else if (phase.name === 'connecting' || phase.name === 'configuring') {
      if (phase.attempt > 0 && failure.retryable) this.#scheduleReconnect(failure);
      else this.#finish(failure);
    }
  }

  #scheduleReconnect(last: Failure): void {
    const attempt = ++this.#reconnects;
    if (attempt > RECONNECT.attempts) {
      this.#finish({ message: `Lost the Gemini connection; ${RECONNECT.attempts} reconnects failed (${last.message})`, retryable: true });
      return;
    }
    const delay = Math.min(RECONNECT.baseMs * 2 ** (attempt - 1), RECONNECT.maxMs);
    this.#log('info', `Gemini reconnect ${attempt}/${RECONNECT.attempts} in ${delay} ms`);
    this.#setPhase({ name: 'reconnecting', attempt }, delay);
    this.#events.onStateChange({ status: 'disconnected' });
  }

  /** Planned switch to a fresh session (`since`: when the old one became ready). Mic audio buffers meanwhile. */
  #rotate(since: number): void {
    const ws = this.#ws;
    this.#ws = null; // its remaining events are ignored from here on
    clearInterval(this.#heartbeat ?? undefined);
    this.#flushTurn();
    if (ws) closeSocket(ws, true, this.#log);
    // A goAway soon after setup is a failure in disguise: back off rather than loop.
    if (Date.now() - since < STABLE_SESSION_MS) {
      this.#scheduleReconnect({ message: 'Gemini sent goAway soon after setup', retryable: true });
      return;
    }
    this.#reconnects = 0;
    this.#connect(1); // attempt > 0: a failed switch retries with backoff instead of ending the session
  }

  /** The current phase's timer ran out: setup deadline, reconnect backoff, goAway drain, or stop() wait. */
  #onTimer(): void {
    const phase = this.#phase;
    if (phase.name === 'reconnecting') {
      this.#connect(phase.attempt);
    } else if (phase.name === 'rotating') {
      this.#log('warn', 'Gemini goAway drain ended before turnComplete; switching sessions');
      this.#rotate(phase.since);
    } else if (phase.name === 'finishing') {
      const left = phase.deadline - Date.now();
      if (this.#turn.open && left > 0) {
        this.#setPhase(phase, Math.min(FINISH_QUIET_MS, left)); // a turn is still open: wait for its turnComplete
        return;
      }
      if (this.#turn.open) this.#log('warn', 'Gemini did not complete the last turn within 8 s; closing');
      this.#finish(null);
    } else if (this.#ws) {
      this.#failure = { message: 'Timed out waiting for the Gemini session to start', retryable: true };
      this.#ws.terminate();
    }
  }

  #handleMessage(data: unknown): void {
    const message = parseMessage(data);
    const content = message?.['serverContent'];
    if (!message) this.#log('warn', 'Ignoring a non-JSON Gemini message');
    else if (isRecord(content)) this.#onServerContent(content);
    else if ('setupComplete' in message) this.#onSetupComplete();
    else if ('goAway' in message) this.#onGoAway(message['goAway']);
    else {
      for (const key of Object.keys(message).filter((k) => !this.#loggedFields.has(k))) {
        this.#loggedFields.add(key);
        this.#log('info', `Unhandled Gemini message "${key}"`);
      }
    }
  }

  #onServerContent(content: Record<string, unknown>): void {
    const turn = this.#turn;
    const source = transcript(content['inputTranscription']);
    const translation = transcript(content['outputTranscription']);
    const model = content['modelTurn'];
    const parts: unknown[] = isRecord(model) && Array.isArray(model['parts']) ? model['parts'] : [];
    if (source || translation || parts.length > 0) turn.open = true;
    turn.source += source;
    turn.translation += translation;
    if (source) this.#events.onSourceText(source);
    if (translation) this.#events.onTranslationText(translation);
    for (const part of parts) this.#onPart(part);
    const interrupted = content['interrupted'] === true;
    if (interrupted) this.#log('info', 'Gemini interrupted the current translation');
    // The turn's last outputTranscription arrives before generationComplete or interrupted.
    if (interrupted || content['generationComplete'] === true) this.#endOutput();
    if (content['turnComplete'] !== true) return;
    this.#flushTurn();
    const phase = this.#phase;
    if (phase.name === 'finishing') this.#finish(null);
    else if (phase.name === 'rotating') this.#rotate(phase.since);
  }

  /** A modelTurn part: inlineData carries the translated speech; other parts hold nothing to play. */
  #onPart(part: unknown): void {
    const inline = isRecord(part) ? part['inlineData'] : undefined;
    if (!isRecord(inline)) return;
    const mimeType = str(inline, 'mimeType');
    // PERF: one base64 decode per chunk, handed to the pipeline without a copy.
    const pcm = Buffer.from(str(inline, 'data') ?? '', 'base64');
    if (pcm.length === 0 || (mimeType !== undefined && !mimeType.startsWith('audio/pcm'))) {
      // Anything but raw PCM would reach the meeting as noise.
      this.#log('warn', `Dropped a Gemini audio part (${mimeType ?? 'no mimeType'}, ${pcm.length} bytes)`);
      return;
    }
    this.#turn.audioInFlight = true;
    this.#events.onAudio(pcm, audioRate(mimeType));
  }

  /** The server will drop this connection soon: flush the open turn, let it drain, then switch sessions. */
  #onGoAway(goAway: unknown): void {
    const phase = this.#phase;
    const leftMs = durationMs(isRecord(goAway) ? goAway['timeLeft'] : undefined);
    this.#log('info', `Gemini goAway (time left: ${leftMs ?? 'unknown'} ms) while ${phase.name}`);
    if (phase.name !== 'ready') return; // finishing has its own deadline; other phases have nothing to drain
    if (!this.#turn.open || !this.#sendJson(AUDIO_STREAM_END)) {
      this.#rotate(phase.since);
      return;
    }
    // Mic audio buffers from here on and goes to the next session.
    const drainMs = leftMs === null ? FINISH_TIMEOUT_MS : Math.min(Math.max(leftMs - GOAWAY_MARGIN_MS, 0), FINISH_TIMEOUT_MS);
    this.#setPhase({ name: 'rotating', since: phase.since }, drainMs);
  }

  #onSetupComplete(): void {
    if (this.#phase.name !== 'configuring') return;
    this.#setPhase({ name: 'ready', since: Date.now() });
    this.#events.onStateChange({ status: 'connected' });
    // Replay audio and queued audioStreamEnd markers held during setup, a session switch or a reconnect.
    let item = this.#pending[0];
    while (item !== undefined && (item === null ? this.#sendJson(AUDIO_STREAM_END) : this.#append(item))) {
      this.#pending.shift();
      this.#pendingSamples -= item?.length ?? 0;
      item = this.#pending[0];
    }
    this.#overflowWarned = false;
    const waiter = this.#startWaiter;
    this.#startWaiter = null;
    waiter?.resolve();
  }

  #append(pcm: Int16Array): boolean {
    // PERF: base64 straight from the Int16Array's memory, no intermediate copy.
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    return this.#sendJson({ realtimeInput: { audio: { data, mimeType: INPUT_MIME } } });
  }

  #sendJson(message: Record<string, unknown>): boolean {
    if (this.#ws?.readyState !== WS_OPEN) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  /** The open turn's output is complete (generationComplete), cut off (interrupted) or abandoned. */
  #endOutput(): void {
    const { translation, audioInFlight } = this.#turn;
    this.#turn = { ...this.#turn, translation: '', audioInFlight: false };
    if (translation) this.#events.onTranslationFinal(translation);
    if (audioInFlight) this.#events.onAudioDone();
  }

  /** Close the open turn and deliver the finals collected so far. */
  #flushTurn(): void {
    this.#endOutput();
    const { source } = this.#turn;
    this.#turn = newTurn();
    if (source) this.#events.onSourceFinal(source);
  }

  /** End the session (`null` = graceful stop), report the final state, settle pending start()/stop(). */
  #finish(failure: Failure | null): void {
    if (failure) this.#log('error', `Gemini session failed: ${failure.message}`);
    this.#flushTurn();
    this.#teardown(failure === null);
    this.#events.onStateChange(failure ? { status: 'error', error: failure.message, retryable: failure.retryable } : { status: 'disconnected' });
    this.#settle(new Error(failure?.message ?? 'Gemini session stopped before it was ready'));
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

  /** Release the socket, timers, buffered audio and turn state without emitting events. */
  #teardown(graceful: boolean): void {
    this.#setPhase({ name: 'closed' });
    clearInterval(this.#heartbeat ?? undefined);
    this.#pending = [];
    this.#pendingSamples = 0;
    this.#turn = newTurn();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) closeSocket(ws, graceful, this.#log);
  }

  #setPhase(next: Phase, timeoutMs?: number): void {
    if (next.name !== this.#phase.name) this.#log('info', `Gemini engine ${this.#phase.name} → ${next.name}`);
    this.#phase = next;
    clearTimeout(this.#timer ?? undefined);
    this.#timer = timeoutMs === undefined ? null : setTimeout(() => this.#guard(() => this.#onTimer()), timeoutMs);
  }

  /** Socket and timer callbacks run outside any caller's try/catch; a throwing callback must not crash main. */
  #guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#log('error', `Gemini engine callback failed: ${errorMessage(err)}`);
    }
  }
}

/**
 * Check the key by running the engine's own handshake: connect, setup, wait for setupComplete, close.
 * Why: that is exactly what fails on a wrong key or on a key without access to the preview model, so one
 * round-trip checks both, with the same error messages a session would show. No audio is sent.
 */
export async function validateGeminiCredentials(params: Credentials): Promise<{ valid: boolean; error?: string }> {
  const ignore = (): void => undefined;
  const engine = new GeminiLiveTranslateEngine({
    ...params,
    events: {
      onSourceText: ignore, onSourceFinal: ignore, onTranslationText: ignore, onTranslationFinal: ignore,
      onAudio: ignore, onAudioDone: ignore, onStateChange: ignore,
      onLog: (level, message) => { if (level !== 'info') console.warn(`[gemini] ${message}`); },
    },
  });
  try {
    await engine.start({ sourceLanguage: 'auto', targetLanguage: 'en' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: errorMessage(err) };
  } finally {
    engine.abort();
  }
}
