/**
 * ElevenLabs streaming text-to-speech for ONE translated utterance, in the user's cloned voice.
 *
 * The translation arrives from the LLM token by token; waiting for the whole sentence would add
 * its full duration to end-to-end latency, so audio goes to `onAudio` the moment it arrives.
 * - eleven_v4_turbo: Text to Dialogue WebSocket, words sent as they complete. If it fails before
 *   any audio, the full text is re-spoken over HTTP with eleven_flash_v2_5.
 * - eleven_flash_v2_5 / eleven_multilingual_v2: HTTP stream, posted once at finish().
 */

import type { TTSModelId } from '../shared/types.js';

// ── WebSocket polyfill for Node.js (same pattern as desktop-pipeline.ts) ──
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws') as { new(url: string, opts?: Record<string, unknown>): WsSocket; OPEN: number };
interface WsSocket {
  readyState: number;
  send(data: string | Buffer): void;
  close(): void;
  terminate(): void; // no close handshake: used for abort and failures
  on(event: string, cb: (...args: unknown[]) => void): void;
}

const ELEVENLABS_ORIGINS = { ws: 'wss://api.elevenlabs.io', http: 'https://api.elevenlabs.io' };
const FALLBACK_MODEL = 'eleven_flash_v2_5';
/** A stuck handshake must fail early enough for the HTTP fallback to still be useful. */
const HANDSHAKE_TIMEOUT_MS = 5_000;
/** The server drops sockets idle for 20 s; ping at half that while a slow LLM is thinking. */
const KEEP_ALIVE_MS = 10_000;
const FINISH_TIMEOUT_MS = 20_000;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_ERROR_DETAIL = 200;
// SECURITY: voiceId is interpolated into URL paths, languageCode into a query string and JSON body.
const VOICE_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const LANGUAGE_CODE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
/** Safe split points: whitespace, plus CJK punctuation because zh/ja text has no spaces between words. */
const BOUNDARY_CHAR_RE = /[\s、。，！？；：]/;

/** Everything one utterance needs; the pipeline builds one per utterance. */
export interface TTSUtteranceOptions {
  apiKey: string;
  voiceId: string;
  modelId: TTSModelId; // 'eleven_v4_turbo' | 'eleven_flash_v2_5' | 'eleven_multilingual_v2'
  /** Target language code (ISO 639-1, or 639-3 like 'fil'), or null to let the model infer. */
  languageCode: string | null;
  voiceSettings: { stability: number; similarityBoost: number; style: number };
  /** Raw PCM s16le mono 24 kHz, delivered as it arrives. Chunks may have odd byte length; the caller realigns. */
  onAudio: (pcm: Buffer) => void;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** TESTS ONLY: origins replacing the ElevenLabs hosts, e.g. `{ ws: 'ws://127.0.0.1:8080', http: 'http://127.0.0.1:8080' }`. */
  baseUrlOverride?: { ws: string; http: string }; // SECURITY: the API key is sent there; never wire to user input
}

/** One utterance in flight. The methods are bound, so they can be passed around as callbacks. */
export interface TTSUtterance {
  /** Append translated text as it streams in. Ignored after finish()/abort(). */
  pushText(text: string): void;
  /** No more text. Resolves when all audio has been delivered, or after a logged failure. Never rejects. */
  finish(): Promise<void>;
  /** Stop now and drop pending audio (barge-in / panic). */
  abort(): void;
}

type HttpModelId = Exclude<TTSModelId, 'eleven_v4_turbo'>;

/** Which transport owns the utterance. Every transition replaces the whole value. */
type Transport =
  | { kind: 'socket'; ws: WsSocket; open: boolean }
  | { kind: 'buffering'; model: HttpModelId } // HTTP: collecting text until finish()
  | { kind: 'streaming'; controller: AbortController }
  | { kind: 'ended' };

class ElevenTTSUtterance implements TTSUtterance {
  readonly #opts: TTSUtteranceOptions;
  readonly #origins: { ws: string; http: string };
  readonly #languageCode: string | null;
  #resolveDone!: () => void; // assigned by #done's initializer, so it must stay declared above it
  readonly #done = new Promise<void>((resolve) => { this.#resolveDone = resolve; });
  #transport: Transport = { kind: 'ended' };
  /** Everything pushed so far: the HTTP body, or the fallback text if v4 Turbo fails. */
  #text = '';
  /** v4 Turbo only: pushed but not yet sent, held back until a word boundary. */
  #unsent = '';
  #finished = false;
  #aborted = false;
  #audioDelivered = false;
  #keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  #finishTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: TTSUtteranceOptions) {
    this.#opts = opts;
    this.#origins = opts.baseUrlOverride ?? ELEVENLABS_ORIGINS;
    // SECURITY: a malformed code is dropped (the model infers the language) instead of being sent.
    const lang = opts.languageCode;
    this.#languageCode = lang !== null && LANGUAGE_CODE_RE.test(lang) ? lang : null;
    if (lang !== null && this.#languageCode === null) {
      opts.log('warn', `TTS: ignoring malformed language code ${JSON.stringify(lang.slice(0, 16))}; the model will infer it`);
    }
    // SECURITY: voiceId goes into a URL path. Its value is not logged (it could be a pasted secret).
    if (!VOICE_ID_RE.test(opts.voiceId)) {
      opts.log('error', 'TTS skipped: the voice id is not a valid ElevenLabs voice id');
      this.#resolveDone();
    } else if (opts.modelId === 'eleven_v4_turbo') {
      this.#openSocket();
    } else {
      this.#transport = { kind: 'buffering', model: opts.modelId };
    }
  }

  pushText(text: string): void {
    const t = this.#transport;
    if (this.#finished || t.kind === 'ended' || text === '') return;
    this.#text += text;
    if (t.kind !== 'socket') return;
    this.#unsent += text;
    if (t.open) this.#sendWords(t.ws, false);
  }

  finish(): Promise<void> {
    const t = this.#transport;
    if (this.#finished || t.kind === 'ended') return this.#done;
    this.#finished = true;
    if (this.#text.trim() === '') {
      this.#end(true); // nothing to say: close without a request and without fallback
    } else if (t.kind === 'buffering') {
      void this.#streamHttp(t.model);
    } else if (t.kind === 'socket') {
      this.#finishTimer = setTimeout(() => {
        this.#opts.log('warn', `TTS: v4 Turbo did not finish within ${FINISH_TIMEOUT_MS / 1000} s; stopping`);
        this.#end(false);
      }, FINISH_TIMEOUT_MS);
      if (t.open) this.#sendFinal(t.ws); // still connecting: #onOpen sends it
    }
    return this.#done;
  }

  abort(): void {
    this.#aborted = true; // checked before every onAudio call
    this.#end(false);
  }

  // ── eleven_v4_turbo: Text to Dialogue WebSocket ──

  /** PERF: called at construction so the handshake overlaps the LLM's time to first token. */
  #openSocket(): void {
    const lang = this.#languageCode === null ? '' : `&language_code=${encodeURIComponent(this.#languageCode)}`;
    const url = `${this.#origins.ws}/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000${lang}`;
    // SECURITY: the key travels only in the handshake header, never in the URL or logs.
    const ws = new WS(url, { headers: { 'xi-api-key': this.#opts.apiKey }, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    this.#transport = { kind: 'socket', ws, open: false };
    ws.on('open', () => this.#onOpen(ws));
    ws.on('message', (data) => this.#onMessage(ws, data));
    ws.on('error', (err) => this.#socketFailed(ws, `v4 Turbo socket error: ${errorText(err)}`));
    // A normal end arrives as is_final first, so a close that still finds us owning the socket is early.
    ws.on('close', (code) => this.#socketFailed(ws, `v4 Turbo socket closed (code ${String(code)})`));
  }

  /** Events from a socket that was already replaced or closed must not touch state. */
  #owns(ws: WsSocket): boolean {
    return this.#transport.kind === 'socket' && this.#transport.ws === ws;
  }

  #onOpen(ws: WsSocket): void {
    if (!this.#owns(ws)) return;
    this.#transport = { kind: 'socket', ws, open: true };
    // Voice and settings go on the first message only and are never resent.
    this.#send(ws, { voices: [this.#opts.voiceId], voice_settings: { stability: this.#opts.voiceSettings.stability } });
    if (this.#finished) this.#sendFinal(ws);
    else this.#sendWords(ws, false);
  }

  /** PERF: send every completed word at once; hold the trailing partial word so it is never split. */
  #sendWords(ws: WsSocket, all: boolean): void {
    const cut = all ? this.#unsent.length : wordBoundary(this.#unsent);
    const chunk = this.#unsent.slice(0, cut);
    if (chunk.trim() === '') return; // whitespace only: keep it as the next word's prefix
    this.#unsent = this.#unsent.slice(cut);
    this.#send(ws, { inputs: [{ text: chunk, voice_id: this.#opts.voiceId, new_turn: false }] });
  }

  #sendFinal(ws: WsSocket): void {
    this.#sendWords(ws, true);
    this.#send(ws, { close_socket: true }); // server flushes, streams the rest, sends is_final, closes
  }

  #send(ws: WsSocket, payload: object): void {
    if (ws.readyState !== WS.OPEN) return; // closing: the 'close' handler decides what happens next
    ws.send(JSON.stringify(payload));
    clearTimeout(this.#keepAliveTimer);
    // After close_socket the server is busy generating, so there is no idle timeout left to reset.
    if (!this.#finished) this.#keepAliveTimer = setTimeout(() => this.#send(ws, { keep_alive: true }), KEEP_ALIVE_MS);
  }

  #onMessage(ws: WsSocket, data: unknown): void {
    if (!this.#owns(ws)) return;
    const msg = parseJsonRecord(data);
    if (msg === null) {
      this.#opts.log('warn', 'TTS: ignored a non-JSON message from v4 Turbo');
      return;
    }
    // PERF: decode and forward immediately; nothing is buffered between socket and audio output.
    if (typeof msg.audio === 'string' && msg.audio !== '') this.#emitAudio(Buffer.from(msg.audio, 'base64'));
    if (msg.error !== undefined && msg.error !== null) {
      this.#socketFailed(ws, `v4 Turbo error ${truncate(JSON.stringify(msg))}`);
    } else if (msg.is_final === true) {
      if (this.#finished) this.#end(true);
      else this.#socketFailed(ws, 'v4 Turbo ended the stream before finish()');
    }
  }

  /** v4 Turbo failed: end if audio already played, otherwise fall back to the HTTP stream. */
  #socketFailed(ws: WsSocket, reason: string): void {
    if (!this.#owns(ws)) return;
    if (this.#audioDelivered) {
      this.#opts.log('warn', `TTS: ${reason}; the rest of this utterance is dropped`);
      this.#end(false);
      return;
    }
    this.#opts.log('warn', `TTS: ${reason} before any audio; falling back to ${FALLBACK_MODEL} over HTTP`);
    this.#clearTimers();
    this.#transport = { kind: 'buffering', model: FALLBACK_MODEL };
    ws.terminate();
    if (this.#finished) void this.#streamHttp(FALLBACK_MODEL); // otherwise finish() starts it with the full text
  }

  // ── eleven_flash_v2_5 / eleven_multilingual_v2 (and the v4 fallback): HTTP stream ──

  /** Never rejects: every failure is logged, then the utterance ends. */
  async #streamHttp(model: HttpModelId): Promise<void> {
    const controller = new AbortController();
    this.#transport = { kind: 'streaming', controller }; // set before the first await so abort() reaches it
    const { apiKey, voiceId, voiceSettings: vs } = this.#opts;
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.#origins.http}/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: this.#text,
          model_id: model,
          voice_settings: { stability: vs.stability, similarity_boost: vs.similarityBoost, style: vs.style, use_speaker_boost: true },
          // Only Flash v2.5 enforces a language; Multilingual v2 may reject the field.
          ...(model === 'eleven_flash_v2_5' && this.#languageCode !== null ? { language_code: this.#languageCode } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) {
        const level = res.status === 402 || res.status === 429 ? 'warn' : 'error';
        this.#opts.log(level, describeHttpError(res.status, await res.text()));
        return;
      }
      const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // PERF: forward each network chunk as it lands (zero-copy view); the caller realigns odd lengths.
        this.#emitAudio(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } catch (err) {
      // abort() cancels the request on purpose; anything else is a real failure.
      const why = controller.signal.aborted ? `timed out after ${HTTP_TIMEOUT_MS / 1000} s` : errorText(err);
      if (!this.#aborted) this.#opts.log('error', `TTS: ElevenLabs stream failed: ${why}`);
    } finally {
      clearTimeout(timer);
      this.#end(false);
    }
  }

  // ── Shared ──

  #emitAudio(pcm: Buffer): void {
    if (this.#aborted || pcm.length === 0) return; // never call onAudio after abort()
    this.#audioDelivered = true;
    try {
      this.#opts.onAudio(pcm);
    } catch (err) {
      // A throwing consumer inside a socket event would otherwise crash the main process.
      this.#opts.log('error', `TTS: onAudio threw: ${errorText(err)}`);
    }
  }

  /** Terminal transition: stop timers and the transport, then resolve finish(). Idempotent. */
  #end(graceful: boolean): void {
    const t = this.#transport;
    this.#transport = { kind: 'ended' };
    this.#clearTimers();
    if (t.kind === 'socket' && graceful) t.ws.close();
    else if (t.kind === 'socket') t.ws.terminate();
    else if (t.kind === 'streaming') t.controller.abort();
    this.#resolveDone();
  }

  #clearTimers(): void {
    clearTimeout(this.#keepAliveTimer);
    clearTimeout(this.#finishTimer);
  }
}

/** Index just past the last safe split point in `text`, or 0 when there is none yet. */
function wordBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (BOUNDARY_CHAR_RE.test(text.charAt(i))) return i + 1;
  }
  return 0;
}

/** ws delivers text frames as Buffers. Returns null for anything that is not a JSON object. */
function parseJsonRecord(data: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // callers log the message or fall back to the raw text
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ERROR_DETAIL ? `${flat.slice(0, MAX_ERROR_DETAIL)}…` : flat;
}

/** Maps ElevenLabs HTTP failures to log lines a user can act on. */
function describeHttpError(status: number, body: string): string {
  if (status === 401) return 'TTS: ElevenLabs rejected the API key (401 invalid key); re-enter it in Settings';
  if (status === 402) return 'TTS: ElevenLabs quota exhausted (402); continuing text-only';
  if (status === 429) return 'TTS: ElevenLabs rate limit hit (429); this utterance was not spoken';
  // ElevenLabs bodies look like {"detail":{"message":…}} or {"detail":"…"}; otherwise log the raw text.
  const json = parseJsonRecord(body);
  const detail = json?.detail ?? json?.message;
  const message = isRecord(detail) && typeof detail.message === 'string' ? detail.message : typeof detail === 'string' ? detail : body;
  const what = status === 422 ? 'rejected the request (422 bad request)' : `returned HTTP ${status}`;
  return `TTS: ElevenLabs ${what}: ${truncate(message)}`;
}

/**
 * Starts speaking one utterance. For eleven_v4_turbo the WebSocket opens right away so the
 * handshake overlaps LLM latency; the HTTP models wait for finish() because they need the full text.
 */
export function startTTSUtterance(options: TTSUtteranceOptions): TTSUtterance {
  const utterance = new ElevenTTSUtterance(options);
  return {
    pushText: (text) => utterance.pushText(text),
    finish: () => utterance.finish(),
    abort: () => utterance.abort(),
  };
}
