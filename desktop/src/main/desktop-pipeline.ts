/**
 * Desktop pipeline — mic → translation → voice → system output (virtual mic).
 *
 * Two paths, chosen per session by the `translationEngine` setting:
 * - cascade (default): ElevenLabs Scribe v3 Live → any LLM (streamed) → ElevenLabs voice (streamed).
 *   The voice starts speaking while the translation is still being written.
 * - speech-to-speech engines (Qwen3.8 LiveTranslate, GPT-Realtime-Translate, Gemini Live Translate):
 *   one model does all three stages; this class only feeds it audio and plays what comes back.
 *
 * All network calls happen in the Electron main process. Translated speech goes to one
 * session-long PcmOutputStream, so utterances play in order and never overlap.
 */

import type { BrowserWindow } from 'electron';
import type { NativeAudioAddon, PcmOutputStream } from '../native/native-addon.js';
import type {
  GlossaryEntry, PipelineStage, ServiceConnectionState, TranslationEngineId, TTSModelId, VADState,
} from '../shared/types.js';
import { AudioRouter, computeRmsDb } from './audio-router.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { sendToRenderer } from './electron-ipc.js';
import { DesktopDebugLog } from './desktop-debug-log.js';
import { DesktopLatencyMonitor } from './desktop-latency.js';
import { LLMTranslator, type TranslationContext } from './llm-translator.js';
import { startTTSUtterance, type TTSUtterance } from './eleven-tts.js';
import type { SpeechEngineEvents, SpeechTranslationEngine } from './speech-engine.js';
import { QwenLiveTranslateEngine } from './qwen-livetranslate-engine.js';
import { OpenAIRealtimeTranslateEngine } from './openai-translate-engine.js';
import { GeminiLiveTranslateEngine } from './gemini-translate-engine.js';

// ── WebSocket polyfill for Node.js ──────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws') as { new(url: string, opts?: Record<string, unknown>): WsSocket; OPEN: number };
interface WsSocket {
  readyState: number;
  send(data: string | Buffer): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

// ── Constants ───────────────────────────────────────────────

const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // "George" built-in voice
const STT_ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const STT_MODEL = 'scribe_v3_live';
const HEARTBEAT_INTERVAL_MS = 15000;
const OUTPUT_SAMPLE_RATE = 24000;
/** Server VAD and turn prediction can finalize the same words twice; identical text this close together is a duplicate. */
const DUPLICATE_COMMIT_WINDOW_MS = 1500;
/** Audio spoken while STT (re)connects is held and sent once it's ready, so first words aren't lost. 10 s max. */
const MAX_PENDING_STT_CHUNKS = 40;
/** After a push-to-talk release, STT closes once the transcript arrives, or after this as a safety net. */
const PTT_COMMIT_WAIT_MS = 5000;
const MAX_HISTORY = 50;
const SERVICES = ['stt', 'llm', 'tts'] as const;

/** Convert Int16Array PCM to base64 (Node.js compatible) */
function pcmToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

// ── Desktop Pipeline ────────────────────────────────────────

export class DesktopPipeline {
  #audioRouter: AudioRouter;
  #nativeAddon: NativeAudioAddon;
  #settings: DesktopSettingsStore;
  #mainWindow: BrowserWindow | null;
  #debugLog: DesktopDebugLog;
  #latencyMonitor: DesktopLatencyMonitor;

  // Session state
  #sessionActive = false;
  #sessionStartedAt = 0;
  #totalUtterances = 0;
  #droppedUtterances = 0;
  #seq = 0;
  #sourceLanguage = 'auto';
  #targetLanguage = 'es';
  #engineId: TranslationEngineId = 'cascade';
  #output: PcmOutputStream | null = null;

  // Cascade: STT WebSocket
  #sttWs: WsSocket | null = null;
  #sttReady = false; // session_started received
  #sttPending: Int16Array[] = [];
  #sttCommitPending = false;
  #sttHeartbeat: ReturnType<typeof setInterval> | null = null;
  #sttWatchdog: ReturnType<typeof setInterval> | null = null;
  #sttMessageCount = 0;
  #lastSttMessageAt = 0;
  #pttCloseTimer: ReturnType<typeof setTimeout> | null = null;
  #recentCommits: Array<{ text: string; at: number }> = [];
  #speechEndedAt: number | null = null;

  // Cascade: translation + voice
  #translator: LLMTranslator | null = null;
  #utteranceQueue: Array<{ text: string; endedAt: number }> = [];
  #processingUtterance = false;
  #utteranceAbort: AbortController | null = null;
  #currentTTS: TTSUtterance | null = null;
  /** Source/translation pairs of this session, in memory only (never persisted). */
  #history: Array<{ source: string; translation: string }> = [];

  // Speech-to-speech engine
  #engine: SpeechTranslationEngine | null = null;
  #engineSource = '';
  #engineSegmentAudio = false;

  // Push-to-talk: when enabled, audio only flows while PTT is held
  #pttEnabled = false;
  #pttActive = false;

  // Config (loaded from settings at session start)
  #apiKey = '';
  #ttsModel: TTSModelId = 'eleven_v4_turbo';
  #voiceId = DEFAULT_VOICE_ID;
  #voiceStability = 0.5;
  #voiceSimilarityBoost = 0.75;
  #voiceStyle = 0.3;
  #contextWindowSize = 10;
  #glossary: GlossaryEntry[] = [];
  #formality: 'formal' | 'informal' = 'informal';
  #meetingContext = '';
  #preserveTechnicalTerms = true;

  constructor(
    nativeAddon: NativeAudioAddon,
    settings: DesktopSettingsStore,
    mainWindow: BrowserWindow | null,
    debugLog: DesktopDebugLog,
  ) {
    this.#nativeAddon = nativeAddon;
    this.#settings = settings;
    this.#mainWindow = mainWindow;
    this.#debugLog = debugLog;
    this.#latencyMonitor = new DesktopLatencyMonitor(mainWindow);
    this.#audioRouter = new AudioRouter(nativeAddon);
  }

  // ── Public API ──────────────────────────────────────────────

  async startSession(params: { sourceLanguage: string; targetLanguage: string }): Promise<void> {
    if (this.#sessionActive) return;

    this.#sessionActive = true;
    this.#sessionStartedAt = Date.now();
    this.#totalUtterances = 0;
    this.#droppedUtterances = 0;
    this.#seq = 0;
    this.#sourceLanguage = params.sourceLanguage;
    this.#targetLanguage = params.targetLanguage;
    this.#resetSessionBuffers();

    const s = this.#settings;
    this.#apiKey = await s.get('elevenLabsApiKey');
    this.#engineId = await s.get('translationEngine');
    this.#ttsModel = await s.get('ttsModel');
    this.#voiceId = (await s.get('voiceProfileId')) || DEFAULT_VOICE_ID;
    this.#voiceStability = await s.get('voiceStability');
    this.#voiceSimilarityBoost = await s.get('voiceSimilarityBoost');
    this.#voiceStyle = await s.get('voiceStyle');
    this.#contextWindowSize = Math.max(0, Math.min(MAX_HISTORY, await s.get('contextWindowSize')));
    this.#glossary = await s.get('customGlossary');
    this.#formality = await s.get('formalityLevel');
    this.#meetingContext = await s.get('meetingContext');
    this.#preserveTechnicalTerms = await s.get('preserveTechnicalTerms');
    this.#pttEnabled = (await s.get('pushToTalk')) === true;
    this.#pttActive = false;

    this.#output = this.#nativeAddon.openPcmOutput(OUTPUT_SAMPLE_RATE, (level, message) => this.#debugLog.log(level, 'audio', message));

    const ready = this.#engineId === 'cascade' ? await this.#startCascade() : await this.#startEngine(this.#engineId);
    if (!ready || !this.#sessionActive) {
      if (this.#sessionActive) await this.stopSession('start-failed');
      return;
    }

    await this.#startCapture();
    this.#emitSessionState();
    this.#debugLog.log('info', 'pipeline', 'Session started', {
      source: params.sourceLanguage, target: params.targetLanguage, engine: this.#engineId,
      ttsModel: this.#ttsModel, llm: this.#translator?.model ?? null, voiceId: this.#voiceId,
    });
  }

  async stopSession(reason: string): Promise<void> {
    if (!this.#sessionActive) return;
    this.#sessionActive = false;
    this.#debugLog.log('info', 'pipeline', `Session stopping: ${reason}`);

    // Stop sound first: stopping means silence now, for a normal stop and for the panic key alike.
    this.#utteranceAbort?.abort();
    this.#currentTTS?.abort();
    this.#currentTTS = null;
    this.#engine?.abort();
    this.#engine = null;
    this.#translator = null;
    this.#output?.interrupt();
    this.#output?.close();
    this.#output = null;

    // Stop capture and kill the ffmpeg process
    this.#audioRouter.transitionRouting({ type: 'session_stop' });
    this.#audioRouter.stop();
    if ('destroy' in this.#nativeAddon) {
      (this.#nativeAddon as { destroy(): void }).destroy();
    }

    this.#closeSTT();
    if (this.#sttWatchdog) { clearInterval(this.#sttWatchdog); this.#sttWatchdog = null; }
    if (this.#pttCloseTimer) { clearTimeout(this.#pttCloseTimer); this.#pttCloseTimer = null; }
    this.#resetSessionBuffers();

    for (const service of SERVICES) this.#emitConnectionState(service, { status: 'disconnected' });
    this.#latencyMonitor.clear();
    this.#emitSessionState();
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.#mainWindow = window;
    this.#latencyMonitor.setMainWindow(window);
  }

  getAudioRouter(): AudioRouter { return this.#audioRouter; }
  isActive(): boolean { return this.#sessionActive; }
  isPTTEnabled(): boolean { return this.#pttEnabled; }

  /** Enable/disable push-to-talk mode */
  setPTTEnabled(enabled: boolean): void {
    this.#pttEnabled = enabled;
    this.#pttActive = false;
    this.#debugLog.log('info', 'pipeline', `PTT mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /** Press PTT — start sending audio */
  pttPress(): void {
    if (!this.#sessionActive || !this.#pttEnabled || this.#pttActive) return;
    this.#pttActive = true;
    if (this.#pttCloseTimer) { clearTimeout(this.#pttCloseTimer); this.#pttCloseTimer = null; }
    this.#debugLog.log('info', 'pipeline', 'PTT pressed — mic open');
    // Audio spoken while STT connects is buffered, so connecting here costs no words.
    if (!this.#engine && !this.#sttWs) void this.#connectSTT();
  }

  /** Release PTT — finish the utterance */
  pttRelease(): void {
    if (!this.#sessionActive || !this.#pttEnabled || !this.#pttActive) return;
    this.#pttActive = false;
    this.#speechEndedAt = Date.now();
    this.#debugLog.log('info', 'pipeline', 'PTT released — mic closed');
    if (this.#engine) {
      this.#engine.endUtterance();
      return;
    }
    this.#commitSTT();
    // STT closes when the committed transcript arrives (see #handleSTTMessage); this is the safety net.
    this.#pttCloseTimer = setTimeout(() => this.#closeIdleSTT('no transcript within 5 s'), PTT_COMMIT_WAIT_MS);
  }

  // ── Session setup ─────────────────────────────────────────

  async #startCascade(): Promise<boolean> {
    if (!this.#apiKey) {
      this.#debugLog.log('error', 'pipeline', 'No ElevenLabs API key — cannot start session');
      this.#emitConnectionState('stt', { status: 'error', error: 'ElevenLabs API key missing', retryable: false });
      return false;
    }
    const s = this.#settings;
    const provider = await s.get('llmProvider');
    const llmApiKey = await s.get('llmApiKey');
    this.#translator = new LLMTranslator(
      { provider, apiKey: llmApiKey, model: await s.get('openRouterModel'), baseUrl: await s.get('llmBaseUrl') },
      (level, message) => this.#debugLog.log(level, 'api', message),
    );
    if (llmApiKey || provider === 'custom') this.#emitConnectionState('llm', { status: 'connected' });
    else this.#emitConnectionState('llm', { status: 'error', error: 'LLM API key missing', retryable: false });
    this.#emitConnectionState('tts', { status: 'connected' }); // per-utterance sockets, nothing to hold open

    this.#debugLog.log('info', 'pipeline', 'Connecting STT...');
    this.#emitConnectionState('stt', { status: 'connecting', attempt: 0 });
    // With push-to-talk the socket opens on the first press; without it, connect now.
    if (!this.#pttEnabled) await this.#connectSTT();

    // Reconnect if the server goes quiet while audio is streaming (VAD mode only).
    this.#sttWatchdog = setInterval(() => {
      if (!this.#sessionActive || this.#pttEnabled || !this.#sttWs) return;
      const silentMs = Date.now() - this.#lastSttMessageAt;
      if (this.#lastSttMessageAt > 0 && silentMs > 15000) {
        this.#debugLog.log('warn', 'connection', `STT silent for ${(silentMs / 1000).toFixed(0)}s — forcing reconnect`);
        this.#closeSTT();
      }
    }, 3000);
    return true;
  }

  async #startEngine(id: Exclude<TranslationEngineId, 'cascade'>): Promise<boolean> {
    const s = this.#settings;
    const events = this.#engineEvents();
    let engine: SpeechTranslationEngine | null = null;
    switch (id) {
      case 'qwen-livetranslate': {
        const apiKey = await s.get('qwenApiKey');
        const workspaceId = await s.get('qwenWorkspaceId');
        if (apiKey && workspaceId) engine = new QwenLiveTranslateEngine({ apiKey, workspaceId, region: await s.get('qwenRegion'), events });
        break;
      }
      case 'openai-realtime-translate': {
        let apiKey = await s.get('openaiTranslateApiKey');
        if (!apiKey && (await s.get('llmProvider')) === 'openai') apiKey = await s.get('llmApiKey');
        if (apiKey) engine = new OpenAIRealtimeTranslateEngine({ apiKey, events });
        break;
      }
      case 'gemini-live-translate': {
        const apiKey = await s.get('geminiApiKey');
        if (apiKey) engine = new GeminiLiveTranslateEngine({ apiKey, events });
        break;
      }
    }
    if (!engine) {
      this.#debugLog.log('error', 'pipeline', `${id}: credentials missing — add them in Settings → Translation engine`);
      for (const service of SERVICES) this.#emitConnectionState(service, { status: 'error', error: 'Engine credentials missing', retryable: false });
      return false;
    }
    this.#engine = engine;
    try {
      await engine.start({ sourceLanguage: this.#sourceLanguage, targetLanguage: this.#targetLanguage });
      return true;
    } catch (err) {
      if (this.#sessionActive) {
        this.#debugLog.log('error', 'pipeline', `${id} failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#engine = null;
      return false;
    }
  }

  async #startCapture(): Promise<void> {
    const ghostMode = await this.#settings.get('ghostMode');
    const deviceId = await this.#settings.get('selectedMicDeviceId');
    const vadSensitivity = await this.#settings.get('vadSensitivity');

    let audioChunkCount = 0;
    this.#audioRouter.onRawAudioChunk = (chunk: Int16Array) => {
      audioChunkCount++;
      if (audioChunkCount === 1 || audioChunkCount % 40 === 0) {
        this.#debugLog.log('info', 'audio', `Mic chunk #${audioChunkCount} (${chunk.length} samples, rms=${computeRmsDb(chunk).toFixed(1)}dB)`);
      }
      this.#onMicChunk(chunk);
    };
    this.#audioRouter.onSpeechEnd = () => { this.#speechEndedAt = Date.now(); };
    this.#audioRouter.onVADStateChange = (state: VADState) => {
      sendToRenderer(this.#mainWindow, 'audio:level', { rmsDb: this.#audioRouter.getInputLevel(), vadState: state.status });
    };

    const vadThresholds = {
      low:    { threshold: -35, onset: 400, offset: 1000 },
      medium: { threshold: -50, onset: 200, offset: 600 },
      high:   { threshold: -60, onset: 150, offset: 400 },
    };
    const vad = vadThresholds[vadSensitivity] ?? vadThresholds.medium;
    this.#audioRouter.start({
      captureDeviceId: deviceId,
      captureSampleRate: 16000,
      outputSampleRate: 48000,
      noiseGateThresholdDb: ghostMode ? -65 : vad.threshold,
      vadSpeechOnsetMs: vad.onset,
      vadSpeechOffsetMs: vad.offset,
      ghostModeEnabled: ghostMode,
    });
    this.#audioRouter.transitionRouting({ type: 'session_start' });
  }

  #onMicChunk(chunk: Int16Array): void {
    if (!this.#sessionActive) return;
    if (this.#pttEnabled && !this.#pttActive) return; // push-to-talk gate
    if (this.#engine) this.#engine.sendAudio(chunk);
    else this.#sendAudioToSTT(chunk);
  }

  #resetSessionBuffers(): void {
    this.#utteranceQueue = [];
    this.#processingUtterance = false;
    this.#utteranceAbort = null;
    this.#history = [];
    this.#recentCommits = [];
    this.#sttPending = [];
    this.#sttCommitPending = false;
    this.#sttMessageCount = 0;
    this.#lastSttMessageAt = 0;
    this.#speechEndedAt = null;
    this.#engineSource = '';
    this.#engineSegmentAudio = false;
  }

  // ── Cascade: STT connection ───────────────────────────────

  async #connectSTT(): Promise<void> {
    if (this.#sttWs) return; // already open or connecting
    return new Promise<void>((resolve) => {
      const query = new URLSearchParams({ model_id: STT_MODEL, audio_format: 'pcm_16000' });
      if (this.#sourceLanguage !== 'auto') query.set('language_code', this.#sourceLanguage);
      if (this.#pttEnabled) {
        query.set('commit_strategy', 'manual'); // we commit on release
      } else {
        // Turn prediction commits when the speaker has finished the thought, not at the first
        // pause, so sentences aren't split mid-way. Silence still commits after 1.5 s.
        query.set('commit_strategy', 'turn_prediction');
        query.set('vad_silence_threshold_secs', '1.5');
        query.set('filter_background_audio', 'true'); // ignore nearby conversations and noise
        query.set('keepalive_interval_ms', '5000'); // lets the watchdog tell silence from a dead socket
      }
      const url = `${STT_ENDPOINT}?${query.toString()}`;
      this.#debugLog.log('info', 'connection', `STT URL: ${url}`);
      this.#sttReady = false;
      // SECURITY: the key goes in the handshake header only, never in the logged URL.
      const ws = new WS(url, { headers: { 'xi-api-key': this.#apiKey } });
      this.#sttWs = ws;

      ws.on('open', () => {
        this.#emitConnectionState('stt', { status: 'connected' });
        this.#debugLog.log('info', 'connection', 'STT connected');
        this.#sttHeartbeat = setInterval(() => {
          if (ws.readyState === WS.OPEN) {
            try { ws.send(Buffer.alloc(0)); } catch (err) { this.#debugLog.log('warn', 'connection', `STT heartbeat failed: ${String(err)}`); }
          }
        }, HEARTBEAT_INTERVAL_MS);
        resolve();
      });

      ws.on('message', (...args: unknown[]) => {
        const data = args[0] as Buffer | string;
        if (ws === this.#sttWs) this.#handleSTTMessage(typeof data === 'string' ? data : data.toString());
      });

      ws.on('error', (...args: unknown[]) => {
        const err = args[0] as Error;
        this.#debugLog.log('error', 'connection', `STT error: ${err.message}`);
        this.#emitConnectionState('stt', { status: 'error', error: err.message, retryable: true });
        resolve();
      });

      ws.on('close', (...args: unknown[]) => {
        const code = args[0] as number | undefined;
        const reason = args[1] as string | undefined;
        if (ws !== this.#sttWs) return; // a socket we already replaced
        this.#debugLog.log('warn', 'connection', `STT closed: code=${code ?? '?'} reason="${reason ?? ''}"`);
        if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }
        this.#sttWs = null;
        this.#sttReady = false;
        if (!this.#sessionActive) return;
        this.#emitConnectionState('stt', { status: 'disconnected' });
        if (this.#pttEnabled && !this.#pttActive) {
          this.#debugLog.log('info', 'connection', 'STT closed (PTT idle) — will reconnect on next press');
          return;
        }
        this.#debugLog.log('info', 'connection', 'STT auto-reconnecting in 500ms...');
        setTimeout(() => {
          if (this.#sessionActive && !this.#sttWs) void this.#connectSTT();
        }, 500);
      });
    });
  }

  #closeSTT(): void {
    const ws = this.#sttWs;
    this.#sttWs = null;
    this.#sttReady = false;
    if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }
    if (ws) {
      try { ws.close(); } catch (err) { this.#debugLog.log('warn', 'connection', `STT close failed: ${String(err)}`); }
    }
  }

  /** Push-to-talk idle: close STT until the next press (saves streaming silence). */
  #closeIdleSTT(why: string): void {
    if (this.#pttCloseTimer) { clearTimeout(this.#pttCloseTimer); this.#pttCloseTimer = null; }
    if (!this.#sessionActive || !this.#pttEnabled || this.#pttActive || !this.#sttWs) return;
    this.#debugLog.log('info', 'connection', `PTT idle (${why}) — closing STT until next press`);
    this.#closeSTT();
  }

  #sendAudioToSTT(chunk: Int16Array): void {
    if (this.#sttWs?.readyState === WS.OPEN && this.#sttReady) {
      this.#sendSTTChunk(chunk);
      return;
    }
    // Not ready yet (connecting after a press, or reconnecting): keep it instead of dropping words.
    this.#sttPending.push(chunk.slice());
    if (this.#sttPending.length > MAX_PENDING_STT_CHUNKS) this.#sttPending.shift();
  }

  #sendSTTChunk(chunk: Int16Array): void {
    this.#sttWs?.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: pcmToBase64(chunk),
      commit: false,
      sample_rate: 16000,
    }));
  }

  /** Force finalization of the current transcript (push-to-talk release). */
  #commitSTT(): void {
    if (this.#sttWs?.readyState !== WS.OPEN || !this.#sttReady) {
      // Released before STT was ready (a short "yes"): commit right after the buffered audio goes out.
      this.#sttCommitPending = true;
      return;
    }
    this.#sttWs.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 }));
    this.#debugLog.log('info', 'pipeline', 'STT commit sent');
  }

  #handleSTTMessage(data: string): void {
    this.#sttMessageCount++;
    this.#lastSttMessageAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.#debugLog.log('error', 'pipeline', 'STT message parse error');
      return;
    }
    const msgType = String(msg['message_type'] ?? msg['type'] ?? 'unknown');
    const text = typeof msg['text'] === 'string' ? msg['text'] : '';

    if (this.#sttMessageCount <= 20 || this.#sttMessageCount % 20 === 0) {
      this.#debugLog.log('info', 'pipeline', `STT msg #${this.#sttMessageCount}: ${msgType} "${text.slice(0, 60)}"`);
    }

    if (msgType === 'session_started') {
      this.#debugLog.log('info', 'connection', `STT session started: ${JSON.stringify(msg['config'] ?? {}).slice(0, 160)}`);
      this.#sttReady = true;
      const pending = this.#sttPending;
      this.#sttPending = [];
      for (const chunk of pending) this.#sendSTTChunk(chunk);
      if (pending.length > 0) this.#debugLog.log('info', 'pipeline', `Sent ${pending.length} buffered audio chunk(s)`);
      if (this.#sttCommitPending) {
        this.#sttCommitPending = false;
        this.#commitSTT();
      }
      return;
    }
    if (msgType.includes('error') || msgType === 'quota_exceeded' || msgType === 'rate_limited' || msgType === 'auth_error') {
      this.#debugLog.log('error', 'pipeline', `STT ${msgType}: ${JSON.stringify(msg['error'] ?? msg).slice(0, 200)}`);
      return;
    }
    if (msgType === 'commit_throttled') {
      this.#debugLog.log('warn', 'pipeline', 'STT commit throttled — too many commits');
      return;
    }
    if (msgType === 'partial_transcript' && text) {
      sendToRenderer(this.#mainWindow, 'pipeline:partial-transcript', { text });
      return;
    }
    if (msgType !== 'committed_transcript' && msgType !== 'committed_transcript_with_timestamps') return;

    const committed = text.trim();
    if (this.#pttEnabled && !this.#pttActive) this.#closeIdleSTT('transcript received');
    if (!committed) return;

    // Only a repeat within a moment is a duplicate; saying "yes" twice in a meeting is not.
    const now = Date.now();
    this.#recentCommits = this.#recentCommits.filter(c => now - c.at < DUPLICATE_COMMIT_WINDOW_MS);
    if (this.#recentCommits.some(c => c.text === committed)) {
      this.#debugLog.log('info', 'pipeline', `Skipping duplicate commit: "${committed.slice(0, 40)}"`);
      return;
    }
    this.#recentCommits.push({ text: committed, at: now });

    this.#debugLog.log('info', 'pipeline', `STT committed: "${committed.slice(0, 80)}"`);
    const endedAt = this.#speechEndedAt ?? now;
    this.#speechEndedAt = null;
    this.#utteranceQueue.push({ text: committed, endedAt });
    void this.#processQueue();
  }

  // ── Cascade: translation + voice ──────────────────────────

  async #processQueue(): Promise<void> {
    if (this.#processingUtterance || !this.#sessionActive) return;
    const batch = this.#utteranceQueue.splice(0);
    const last = batch[batch.length - 1];
    if (!last) return;
    this.#processingUtterance = true;
    // Backlog: never drop speech. Everything waiting goes out as one translation, which is faster
    // than translating each piece in turn and keeps every word.
    const text = batch.map(u => u.text).join(' ');
    if (batch.length > 1) this.#debugLog.log('info', 'pipeline', `Merged ${batch.length} queued utterances to catch up`);
    const seq = ++this.#seq;
    this.#totalUtterances += batch.length;
    try {
      await this.#translateAndSpeak(seq, text, last.endedAt);
    } catch (err) {
      this.#droppedUtterances++;
      this.#debugLog.log('error', 'pipeline', `Utterance #${seq} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#processingUtterance = false;
      this.#emitSessionState();
    }
    if (this.#sessionActive && this.#utteranceQueue.length > 0) void this.#processQueue();
  }

  async #translateAndSpeak(seq: number, text: string, endedAt: number): Promise<void> {
    const translator = this.#translator;
    const output = this.#output;
    if (!translator || !output) return;

    // Latency is measured from when the speaker stopped, which is the delay listeners notice.
    this.#latencyMonitor.markCaptureStart(seq, endedAt);
    this.#latencyMonitor.markCaptureEnd(seq, endedAt);
    this.#latencyMonitor.markSTTEnd(seq);
    this.#emitStage(seq, 'TRANSCRIBED');

    // The user may switch voices mid-session.
    const profileId = await this.#settings.get('voiceProfileId');
    if (profileId) this.#voiceId = profileId;

    const abort = new AbortController();
    this.#utteranceAbort = abort;
    let firstAudio = true;
    // PERF: the voice socket opens now, in parallel with the LLM request.
    const tts = startTTSUtterance({
      apiKey: this.#apiKey,
      voiceId: this.#voiceId,
      modelId: this.#ttsModel,
      languageCode: this.#targetLanguage,
      voiceSettings: { stability: this.#voiceStability, similarityBoost: this.#voiceSimilarityBoost, style: this.#voiceStyle },
      onAudio: (pcm) => {
        if (!this.#sessionActive || abort.signal.aborted) return;
        output.write(pcm);
        if (firstAudio) {
          firstAudio = false;
          this.#latencyMonitor.markTTSFirstByte(seq);
          this.#emitStage(seq, 'SYNTHESIZED');
          this.#latencyMonitor.markPlaybackStart(seq);
        }
      },
      log: (level, message) => this.#debugLog.log(level, 'api', message),
    });
    this.#currentTTS = tts;

    this.#latencyMonitor.markTranslationStart(seq);
    let firstToken = true;
    const translation = await translator.translate(text, this.#translationContext(), (token) => {
      if (firstToken) {
        firstToken = false;
        this.#latencyMonitor.markTranslationFirstToken(seq);
        this.#emitStage(seq, 'TRANSLATED');
      }
      tts.pushText(token); // PERF: the voice starts while the sentence is still being written
    }, abort.signal);

    if (!translation || !this.#sessionActive) {
      tts.abort();
      this.#currentTTS = null;
      if (this.#sessionActive) {
        this.#droppedUtterances++;
        this.#emitStage(seq, 'DROPPED');
      }
      return;
    }
    this.#debugLog.log('info', 'pipeline', `#${seq} "${text.slice(0, 60)}" → "${translation.slice(0, 80)}"`);
    this.#history.push({ source: text, translation });
    if (this.#history.length > MAX_HISTORY) this.#history.shift();

    await tts.finish();
    this.#currentTTS = null;
    output.flush();
    if (this.#sessionActive) this.#emitStage(seq, 'PLAYED');
  }

  #translationContext(): TranslationContext {
    return {
      sourceLanguage: this.#sourceLanguage,
      targetLanguage: this.#targetLanguage,
      history: this.#contextWindowSize > 0 ? this.#history.slice(-this.#contextWindowSize) : [],
      glossary: this.#glossary,
      formality: this.#formality,
      meetingContext: this.#meetingContext,
      preserveTechnicalTerms: this.#preserveTechnicalTerms,
    };
  }

  // ── Speech-to-speech engines ──────────────────────────────

  #engineEvents(): SpeechEngineEvents {
    return {
      onSourceText: (delta) => {
        this.#engineSource += delta;
        sendToRenderer(this.#mainWindow, 'pipeline:partial-transcript', { text: this.#engineSource.slice(-500) });
      },
      onSourceFinal: (text) => {
        this.#engineSource = '';
        this.#totalUtterances++;
        this.#debugLog.log('info', 'pipeline', `Heard: "${text.slice(0, 80)}"`);
        this.#emitSessionState();
      },
      onTranslationText: () => { /* audio carries it; the final text is logged below */ },
      onTranslationFinal: (text) => this.#debugLog.log('info', 'pipeline', `Translated: "${text.slice(0, 80)}"`),
      onAudio: (pcm, sampleRate) => {
        if (!this.#sessionActive) return;
        const audio = sampleRate === OUTPUT_SAMPLE_RATE ? pcm : this.#nativeAddon.resample(pcm, sampleRate, OUTPUT_SAMPLE_RATE);
        this.#output?.write(audio);
        if (!this.#engineSegmentAudio) {
          this.#engineSegmentAudio = true;
          this.#emitStage(++this.#seq, 'SYNTHESIZED');
        }
      },
      onAudioDone: () => {
        this.#engineSegmentAudio = false;
        this.#output?.flush();
      },
      onStateChange: (state) => {
        for (const service of SERVICES) this.#emitConnectionState(service, state);
      },
      onLog: (level, message) => this.#debugLog.log(level, 'pipeline', message),
    };
  }

  // ── IPC Helpers ───────────────────────────────────────────

  #emitSessionState(): void {
    sendToRenderer(this.#mainWindow, 'session:state-changed', {
      active: this.#sessionActive,
      startedAt: this.#sessionStartedAt,
      sourceLanguage: this.#sourceLanguage,
      targetLanguage: this.#targetLanguage,
      totalUtterances: this.#totalUtterances,
      droppedUtterances: this.#droppedUtterances,
      currentSequenceId: this.#seq,
      voiceTimeMs: 0, ttsCharactersUsed: 0, sttSecondsUsed: 0, llmTokensUsed: 0,
    });
  }

  #emitStage(sequenceId: number, stage: PipelineStage): void {
    sendToRenderer(this.#mainWindow, 'pipeline:stage-update', { sequenceId, stage });
  }

  #emitConnectionState(service: 'stt' | 'tts' | 'llm', state: ServiceConnectionState): void {
    sendToRenderer(this.#mainWindow, 'connection:state-changed', { service, state });
  }
}
