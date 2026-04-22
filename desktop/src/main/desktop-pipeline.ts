/**
 * Desktop pipeline — FULL end-to-end wiring.
 *
 * Mic → STT (ElevenLabs Scribe) → Translation (LLM) → TTS (ElevenLabs) → BlackHole
 *
 * This replaces the Chrome extension's offscreen document pipeline.
 * All WebSocket and HTTP calls happen in the Electron main process.
 * Audio capture uses the native addon (mock for now, real mic later).
 */

import type { BrowserWindow } from 'electron';
import type { NativeAudioAddon } from '../native/native-addon.js';
import type {
  SessionState, VADState, ServiceConnectionState,
  PipelineStage, DegradationLevel, EchoState,
} from '../shared/types.js';
import { AudioRouter, computeRmsDb } from './audio-router.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { sendToRenderer } from './electron-ipc.js';
import { DesktopDebugLog } from './desktop-debug-log.js';
import { DesktopLatencyMonitor } from './desktop-latency.js';

// ── WebSocket polyfill for Node.js ──────────────────────────
// Electron main process has no browser WebSocket — use the ws package
// which is bundled with Electron
const WebSocket = require('ws') as typeof import('ws').default;

// ── Constants ───────────────────────────────────────────────

const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // "George" built-in voice
const STT_ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const HEARTBEAT_INTERVAL_MS = 15000;
const CHUNK_LENGTH_SCHEDULE = [50, 120, 200, 260];

// ── Helpers ─────────────────────────────────────────────────

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
  #currentSequenceId = 0;
  #sourceLanguage = 'auto';
  #targetLanguage = 'es';

  // WebSocket connections
  #sttWs: InstanceType<typeof WebSocket> | null = null;
  #ttsWs: InstanceType<typeof WebSocket> | null = null;
  #sttHeartbeat: ReturnType<typeof setInterval> | null = null;
  #ttsHeartbeat: ReturnType<typeof setInterval> | null = null;

  // Pipeline config (loaded from settings at session start)
  #apiKey = '';
  #llmApiKey = '';
  #llmProvider = 'openrouter';
  #openRouterModel = 'openai/gpt-4o';
  #voiceId = DEFAULT_VOICE_ID;
  #voiceStability = 0.5;
  #voiceSimilarityBoost = 0.75;
  #voiceStyle = 0.3;

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
    this.#currentSequenceId = 0;
    this.#sourceLanguage = params.sourceLanguage;
    this.#targetLanguage = params.targetLanguage;

    // Load settings
    this.#apiKey = await this.#settings.get('elevenLabsApiKey');
    this.#llmApiKey = await this.#settings.get('llmApiKey');
    this.#llmProvider = await this.#settings.get('llmProvider');
    this.#openRouterModel = await this.#settings.get('openRouterModel');
    const profileId = await this.#settings.get('voiceProfileId');
    this.#voiceId = profileId || DEFAULT_VOICE_ID;
    this.#voiceStability = await this.#settings.get('voiceStability');
    this.#voiceSimilarityBoost = await this.#settings.get('voiceSimilarityBoost');
    this.#voiceStyle = await this.#settings.get('voiceStyle');

    if (!this.#apiKey) {
      this.#debugLog.log('error', 'pipeline', 'No ElevenLabs API key — cannot start session');
      this.#sessionActive = false;
      return;
    }

    // 1. Connect STT WebSocket
    this.#debugLog.log('info', 'pipeline', 'Connecting STT...');
    this.#emitConnectionState('stt', { status: 'connecting', attempt: 0 });
    await this.#connectSTT();

    // 2. Connect TTS WebSocket
    this.#debugLog.log('info', 'pipeline', 'Connecting TTS...');
    this.#emitConnectionState('tts', { status: 'connecting', attempt: 0 });
    await this.#connectTTS();

    // 3. Mark LLM as connected (it's HTTP, always available if key exists)
    if (this.#llmApiKey) {
      this.#emitConnectionState('llm', { status: 'connected' });
    }

    // 4. Start audio capture
    const noiseGate = await this.#settings.get('noiseGateThresholdDb');
    const ghostMode = await this.#settings.get('ghostMode');
    const deviceId = await this.#settings.get('selectedMicDeviceId');

    let audioChunkCount = 0;
    this.#audioRouter.onRawAudioChunk = (chunk: Int16Array) => {
      audioChunkCount++;
      if (audioChunkCount === 1 || audioChunkCount % 20 === 0) {
        this.#debugLog.log('info', 'audio', `Sending chunk #${audioChunkCount} to STT (${chunk.length} samples, rms=${computeRmsDb(chunk).toFixed(1)}dB)`);
      }
      this.#sendAudioToSTT(chunk);
    };
    this.#audioRouter.onSpeechEnd = () => this.#handleSpeechEnd();
    this.#audioRouter.onVADStateChange = (state: VADState) => {
      sendToRenderer(this.#mainWindow, 'audio:level', {
        rmsDb: this.#audioRouter.getInputLevel(),
        vadState: state.status,
      });
    };

    this.#audioRouter.start({
      captureDeviceId: deviceId,
      captureSampleRate: 16000,
      outputSampleRate: 48000,
      noiseGateThresholdDb: noiseGate,
      vadSpeechOnsetMs: 300,
      vadSpeechOffsetMs: 800,
      ghostModeEnabled: ghostMode,
    });

    this.#audioRouter.transitionRouting({ type: 'session_start' });
    this.#emitSessionState();

    this.#debugLog.log('info', 'pipeline', 'Session started', {
      source: params.sourceLanguage, target: params.targetLanguage,
      voiceId: this.#voiceId, llmProvider: this.#llmProvider,
    });
  }

  async stopSession(reason: string): Promise<void> {
    if (!this.#sessionActive) return;
    this.#sessionActive = false;

    this.#debugLog.log('info', 'pipeline', `Session stopping: ${reason}`);

    // Stop audio
    this.#audioRouter.transitionRouting({ type: 'session_stop' });
    this.#audioRouter.stop();

    // Disconnect STT
    if (this.#sttWs) {
      try { this.#sttWs.send(JSON.stringify({ message_type: 'close_stream' })); } catch {}
      this.#sttWs.close();
      this.#sttWs = null;
    }
    if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }

    // Disconnect TTS
    if (this.#ttsWs) {
      try { this.#ttsWs.send(JSON.stringify({ text: '' })); } catch {}
      this.#ttsWs.close();
      this.#ttsWs = null;
    }
    if (this.#ttsHeartbeat) { clearInterval(this.#ttsHeartbeat); this.#ttsHeartbeat = null; }

    this.#emitConnectionState('stt', { status: 'disconnected' });
    this.#emitConnectionState('tts', { status: 'disconnected' });
    this.#emitConnectionState('llm', { status: 'disconnected' });

    this.#latencyMonitor.clear();
    this.#emitSessionState();
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.#mainWindow = window;
    this.#latencyMonitor.setMainWindow(window);
  }

  getAudioRouter(): AudioRouter { return this.#audioRouter; }
  isActive(): boolean { return this.#sessionActive; }

  // ── STT Connection ────────────────────────────────────────

  async #connectSTT(): Promise<void> {
    return new Promise<void>((resolve) => {
      const url = `${STT_ENDPOINT}?model_id=scribe_v2_realtime`;
      const ws = new WebSocket(url, {
        headers: { 'xi-api-key': this.#apiKey },
      });
      this.#sttWs = ws;

      ws.on('open', () => {
        this.#emitConnectionState('stt', { status: 'connected' });
        this.#debugLog.log('info', 'connection', 'STT connected');

        // Heartbeat
        this.#sttHeartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(Buffer.alloc(0)); } catch {}
          }
        }, HEARTBEAT_INTERVAL_MS);

        resolve();
      });

      ws.on('message', (data: Buffer | string) => {
        this.#handleSTTMessage(typeof data === 'string' ? data : data.toString());
      });

      ws.on('error', (err: Error) => {
        this.#debugLog.log('error', 'connection', `STT error: ${err.message}`);
        this.#emitConnectionState('stt', { status: 'error', error: err.message, retryable: true });
        resolve(); // Don't block session start
      });

      ws.on('close', () => {
        if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }
        if (this.#sessionActive) {
          this.#emitConnectionState('stt', { status: 'disconnected' });
        }
      });
    });
  }

  #sendAudioToSTT(chunk: Int16Array): void {
    if (this.#sttWs?.readyState === WebSocket.OPEN) {
      this.#sttWs.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: pcmToBase64(chunk),
        sample_rate: 16000,
      }));
    }
  }

  // Track latest partial for speech-end trigger
  #lastPartialText = '';
  #lastTranslatedText = '';

  #handleSTTMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as Record<string, unknown>;
      const msgType = (msg['message_type'] ?? msg['type'] ?? 'unknown') as string;
      const text = (msg['text'] ?? '') as string;

      if (msgType === 'partial_transcript' && text) {
        this.#lastPartialText = text;
      }

      if (msgType === 'committed_transcript' || msgType === 'committed_transcript_with_timestamps') {
        const finalText = (text || this.#lastPartialText).trim();
        if (finalText && finalText !== this.#lastTranslatedText) {
          this.#lastTranslatedText = finalText;
          this.#debugLog.log('info', 'pipeline', `STT committed: "${finalText.slice(0, 80)}"`);
          this.#latencyMonitor.markSTTEnd(this.#currentSequenceId);
          this.#emitStage(this.#currentSequenceId, 'TRANSCRIBED');
          this.#translateAndSpeak(finalText, this.#currentSequenceId);
        }
        this.#lastPartialText = '';
      }

      if (msgType === 'input_error') {
        this.#debugLog.log('warn', 'pipeline', `STT input_error: ${JSON.stringify(msg['error'])}`);
      }
    } catch {
      this.#debugLog.log('error', 'pipeline', 'STT message parse error');
    }
  }

  #handleSpeechEnd(): void {
    if (!this.#sessionActive) return;
    this.#currentSequenceId++;
    this.#totalUtterances++;

    this.#latencyMonitor.markCaptureEnd(this.#currentSequenceId);
    this.#emitStage(this.#currentSequenceId, 'CAPTURED');

    // If we have a partial transcript that hasn't been committed yet, use it directly
    const pendingText = this.#lastPartialText.trim();
    if (pendingText && pendingText !== this.#lastTranslatedText) {
      this.#lastTranslatedText = pendingText;
      this.#lastPartialText = '';
      this.#debugLog.log('info', 'pipeline', `STT (from partial): "${pendingText.slice(0, 80)}"`);
      this.#latencyMonitor.markSTTEnd(this.#currentSequenceId);
      this.#emitStage(this.#currentSequenceId, 'TRANSCRIBED');
      this.#translateAndSpeak(pendingText, this.#currentSequenceId);
    }

    // Note: commit not supported on this endpoint — partials are used directly

    this.#debugLog.log('info', 'pipeline', `Utterance ${this.#currentSequenceId} captured — commit sent`);
  }

  // ── Translation ───────────────────────────────────────────

  async #translateAndSpeak(text: string, sequenceId: number): Promise<void> {
    this.#latencyMonitor.markTranslationStart(sequenceId);

    try {
      let url: string;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let body: Record<string, unknown>;

      if (this.#llmProvider === 'anthropic') {
        url = 'https://api.anthropic.com/v1/messages';
        headers['x-api-key'] = this.#llmApiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = {
          model: 'claude-sonnet-4-20250514',
          system: this.#buildTranslationPrompt(),
          messages: [{ role: 'user', content: text }],
          stream: true, max_tokens: 500,
        };
      } else {
        // OpenAI or OpenRouter
        url = this.#llmProvider === 'openrouter'
          ? 'https://openrouter.ai/api/v1/chat/completions'
          : 'https://api.openai.com/v1/chat/completions';
        headers['Authorization'] = `Bearer ${this.#llmApiKey}`;
        if (this.#llmProvider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://voicebridge.app';
          headers['X-Title'] = 'VoiceBridge';
        }
        const model = this.#llmProvider === 'openrouter' ? this.#openRouterModel : 'gpt-4o';
        body = {
          model,
          messages: [
            { role: 'system', content: this.#buildTranslationPrompt() },
            { role: 'user', content: text },
          ],
          stream: true, max_tokens: 500, temperature: 0.3,
        };
      }

      const response = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        this.#debugLog.log('error', 'pipeline', `LLM error: ${response.status}`);
        this.#droppedUtterances++;
        return;
      }

      // Stream tokens → TTS
      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';
      let fullTranslation = '';
      let firstToken = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;

          try {
            let token: string | undefined;
            const parsed = JSON.parse(data) as Record<string, unknown>;

            if (this.#llmProvider === 'anthropic') {
              const p = parsed as { type?: string; delta?: { text?: string } };
              if (p.type === 'content_block_delta') token = p.delta?.text;
            } else {
              const p = parsed as { choices?: Array<{ delta?: { content?: string } }> };
              token = p.choices?.[0]?.delta?.content;
            }

            if (token) {
              if (firstToken) {
                this.#latencyMonitor.markTranslationFirstToken(sequenceId);
                this.#emitStage(sequenceId, 'TRANSLATED');
                firstToken = false;
              }
              fullTranslation += token;
              // Stream token to TTS
              this.#sendTextToTTS(token);
            }
          } catch { /* skip malformed */ }
        }
      }

      if (fullTranslation) {
        this.#debugLog.log('info', 'pipeline', `Translation: "${fullTranslation.slice(0, 80)}"`);
        // Flush TTS to generate remaining audio
        this.#flushTTS();
      }

    } catch (err) {
      this.#debugLog.log('error', 'pipeline', `Translation failed: ${err instanceof Error ? err.message : String(err)}`);
      this.#droppedUtterances++;
    }
  }

  #buildTranslationPrompt(): string {
    const src = this.#sourceLanguage === 'auto' ? 'the detected language' : this.#sourceLanguage;
    return `You are a real-time speech translator. Translate from ${src} to ${this.#targetLanguage}. Output ONLY the translated text. No explanations, no brackets, no notes. Keep it concise and natural.`;
  }

  // ── TTS Connection ────────────────────────────────────────

  async #connectTTS(): Promise<void> {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.#voiceId}/stream-input?model_id=eleven_flash_v2_5`;

    return new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      this.#ttsWs = ws;

      ws.on('open', () => {
        // Init message
        ws.send(JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: this.#voiceStability,
            similarity_boost: this.#voiceSimilarityBoost,
            style: this.#voiceStyle,
            use_speaker_boost: true,
          },
          generation_config: { chunk_length_schedule: CHUNK_LENGTH_SCHEDULE },
          xi_api_key: this.#apiKey,
          output_format: 'pcm_24000',
        }));

        this.#emitConnectionState('tts', { status: 'connected' });
        this.#debugLog.log('info', 'connection', 'TTS connected');

        // Heartbeat
        this.#ttsHeartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(Buffer.alloc(0)); } catch {}
          }
        }, HEARTBEAT_INTERVAL_MS);

        resolve();
      });

      ws.on('message', (data: Buffer | string) => {
        this.#handleTTSMessage(data);
      });

      ws.on('error', (err: Error) => {
        this.#debugLog.log('error', 'connection', `TTS error: ${err.message}`);
        this.#emitConnectionState('tts', { status: 'error', error: err.message, retryable: true });
        resolve();
      });

      ws.on('close', () => {
        if (this.#ttsHeartbeat) { clearInterval(this.#ttsHeartbeat); this.#ttsHeartbeat = null; }
        if (this.#sessionActive) {
          this.#emitConnectionState('tts', { status: 'disconnected' });
        }
      });
    });
  }

  #sendTextToTTS(text: string): void {
    if (this.#ttsWs?.readyState === WebSocket.OPEN) {
      this.#ttsWs.send(JSON.stringify({ text }));
    }
  }

  #flushTTS(): void {
    if (this.#ttsWs?.readyState === WebSocket.OPEN) {
      this.#ttsWs.send(JSON.stringify({ text: '', flush: true }));
    }
  }

  #ttsMessageCount = 0;

  #handleTTSMessage(data: Buffer | string): void {
    this.#ttsMessageCount++;

    // Try JSON first — TTS sends base64 audio in JSON messages
    const str = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const msg = JSON.parse(str) as { audio?: string; isFinal?: boolean; message?: string };

      if (msg.audio) {
        const audioBuffer = Buffer.from(msg.audio, 'base64');
        if (this.#ttsMessageCount <= 3 || this.#ttsMessageCount % 20 === 0) {
          this.#debugLog.log('info', 'pipeline', `TTS audio chunk #${this.#ttsMessageCount}: ${audioBuffer.length} bytes`);
        }
        this.#latencyMonitor.markTTSFirstByte(this.#currentSequenceId);
        this.#emitStage(this.#currentSequenceId, 'SYNTHESIZED');
        this.#audioRouter.writeTTSAudio(audioBuffer);
        this.#audioRouter.transitionRouting({ type: 'tts_start' });
      }

      if (msg.isFinal) {
        this.#audioRouter.transitionRouting({ type: 'tts_end' });
        this.#latencyMonitor.markPlaybackStart(this.#currentSequenceId);
        this.#emitStage(this.#currentSequenceId, 'PLAYED');
        this.#debugLog.log('info', 'pipeline', `Utterance ${this.#currentSequenceId} played (${this.#ttsMessageCount} TTS messages)`);
        this.#ttsMessageCount = 0;
      }

      return;
    } catch {
      // Not JSON — treat as raw binary PCM
    }

    // Raw binary audio fallback
    if (Buffer.isBuffer(data) && data.length > 100) {
      this.#debugLog.log('info', 'pipeline', `TTS raw binary: ${data.length} bytes`);
      this.#audioRouter.writeTTSAudio(data);
      this.#audioRouter.transitionRouting({ type: 'tts_start' });
    }
    } catch { /* skip */ }
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
      currentSequenceId: this.#currentSequenceId,
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
