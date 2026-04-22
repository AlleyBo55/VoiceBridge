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
    this.#lastPartialText = '';
    this.#processedTextLength = 0;
    this.#lastPartialTimestamp = 0;
    this.#ttsTextQueue = '';
    this.#utteranceQueue = [];
    this.#processingUtterance = false;
    if (this.#partialStableTimer) { clearTimeout(this.#partialStableTimer); this.#partialStableTimer = null; }
    if (this.#ttsFlushTimer) { clearTimeout(this.#ttsFlushTimer); this.#ttsFlushTimer = null; }

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

    // 2. LLM + TTS use REST APIs — no WebSocket needed
    if (this.#llmApiKey) {
      this.#emitConnectionState('llm', { status: 'connected' });
    }
    this.#emitConnectionState('tts', { status: 'connected' });

    // 4. Start audio capture
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

    const vadSensitivity = await this.#settings.get('vadSensitivity');
    const vadThresholds = {
      low:    { threshold: -35, onset: 400, offset: 1000 },
      medium: { threshold: -50, onset: 200, offset: 600 },
      high:   { threshold: -60, onset: 150, offset: 400 },
    };
    const vad = vadThresholds[vadSensitivity as keyof typeof vadThresholds] ?? vadThresholds.medium;

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

    // Stop audio and kill ffmpeg output process
    this.#audioRouter.transitionRouting({ type: 'session_stop' });
    this.#audioRouter.stop();
    // Kill the ffmpeg output process so next session starts fresh
    if ('destroy' in this.#nativeAddon) {
      (this.#nativeAddon as { destroy(): void }).destroy();
    }

    // Disconnect STT
    if (this.#sttWs) {
      try { this.#sttWs.close(); } catch(_e) {}
      this.#sttWs = null;
    }
    if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }

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
            try { ws.send(Buffer.alloc(0)); } catch(_e) {}
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
  #processedTextLength = 0;
  #partialStableTimer: ReturnType<typeof setTimeout> | null = null;
  #lastPartialTimestamp = 0; // How many chars of the accumulated STT text we've already translated

  #handleSTTMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as Record<string, unknown>;
      const msgType = (msg['message_type'] ?? msg['type'] ?? 'unknown') as string;
      const text = (msg['text'] ?? '') as string;

      if (msgType === 'partial_transcript' && text) {
        this.#lastPartialText = text;
        this.#lastPartialTimestamp = Date.now();

        // When partial text stabilizes (no change for 1.5s) AND has new content, translate
        if (this.#partialStableTimer) clearTimeout(this.#partialStableTimer);
        this.#partialStableTimer = setTimeout(() => {
          if (this.#sessionActive && this.#lastPartialText.trim().length > this.#processedTextLength) {
            this.#debugLog.log('info', 'pipeline', `STT stable 0.8s — translating`);
            this.#triggerTranslation();
          }
        }, 1200);
      }

      if (msgType === 'committed_transcript' || msgType === 'committed_transcript_with_timestamps') {
        const fullText = (text || this.#lastPartialText).trim();
        if (fullText && fullText.length > this.#processedTextLength) {
          const newText = fullText.slice(this.#processedTextLength).trim();
          if (newText) {
            this.#processedTextLength = fullText.length;
            this.#debugLog.log('info', 'pipeline', `STT committed (new): "${newText.slice(0, 80)}"`);
            this.#latencyMonitor.markSTTEnd(this.#currentSequenceId);
            this.#emitStage(this.#currentSequenceId, 'TRANSCRIBED');
            this.#translateAndSpeak(newText, this.#currentSequenceId);
          }
        }
        this.#lastPartialText = '';
      }

      if (msgType === 'input_error') {
        this.#debugLog.log('warn', 'pipeline', `STT input_error: ${JSON.stringify(msg['error'])}`);
      }
    } catch(_e) {
      this.#debugLog.log('error', 'pipeline', 'STT message parse error');
    }
  }

  async #handleSpeechEnd(): Promise<void> {
    if (!this.#sessionActive) return;
    this.#currentSequenceId++;
    this.#totalUtterances++;
    this.#latencyMonitor.markCaptureEnd(this.#currentSequenceId);
    this.#emitStage(this.#currentSequenceId, 'CAPTURED');
    await this.#triggerTranslation();
    this.#debugLog.log('info', 'pipeline', `Utterance ${this.#currentSequenceId} captured`);
  }

  /** Extract new text from STT partials and send to translation + TTS */
  async #triggerTranslation(): Promise<void> {
    const fullText = this.#lastPartialText.trim();
    if (!fullText || fullText.length <= this.#processedTextLength) {
      if (!fullText && this.#processedTextLength > 0) {
        this.#processedTextLength = 0;
      }
      return;
    }

    const newText = fullText.slice(this.#processedTextLength).trim();
    if (!newText) return;

    this.#processedTextLength = fullText.length;
    this.#debugLog.log('info', 'pipeline', `STT (new): "${newText.slice(0, 80)}"`);
    this.#latencyMonitor.markSTTEnd(this.#currentSequenceId);
    this.#emitStage(this.#currentSequenceId, 'TRANSCRIBED');

    // Queue the utterance — processed serially, in order, no drops
    this.#enqueueUtterance(newText, this.#currentSequenceId);

    // Reset STT — its accumulation buffer stops producing new partials once text stabilizes
    this.#processedTextLength = 0;
    this.#lastPartialText = '';
    if (this.#sttWs) {
      try { this.#sttWs.close(); } catch(_e5) {}
      this.#sttWs = null;
    }
    if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }
    await this.#connectSTT();
  }

  // ── Utterance Queue (like OBS frame buffer) ───────────────
  // Every utterance is queued and processed serially.
  // No drops. No races. In order. Always.

  #utteranceQueue: Array<{ text: string; seqId: number }> = [];
  #processingUtterance = false;

  #enqueueUtterance(text: string, seqId: number): void {
    this.#utteranceQueue.push({ text, seqId });
    this.#debugLog.log('info', 'pipeline', `Queued utterance #${seqId} (${this.#utteranceQueue.length} in queue)`);
    this.#processNextUtterance();
  }

  async #processNextUtterance(): Promise<void> {
    if (this.#processingUtterance) return; // Already processing one
    if (this.#utteranceQueue.length === 0) return; // Nothing to process
    if (!this.#sessionActive) return;

    this.#processingUtterance = true;
    const { text, seqId } = this.#utteranceQueue.shift()!;

    try {
      // 1. Translate
      const translation = await this.#translate(text, seqId);
      if (!translation || !this.#sessionActive) {
        this.#processingUtterance = false;
        this.#processNextUtterance();
        return;
      }

      // 2. Generate speech via REST TTS
      await this.#speakWithRestTTS(translation);

      this.#debugLog.log('info', 'pipeline', `✓ Utterance #${seqId} complete (${this.#utteranceQueue.length} remaining)`);
    } catch (err) {
      this.#debugLog.log('error', 'pipeline', `Utterance #${seqId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.#processingUtterance = false;
    // Process next in queue
    if (this.#sessionActive) {
      this.#processNextUtterance();
    }
  }

  // ── Translation ───────────────────────────────────────────

  /** Translate text and return the result. Does NOT speak it. */
  async #translate(text: string, sequenceId: number): Promise<string | null> {
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
            }
          } catch(_e2) { /* skip malformed */ }
        }
      }

      if (fullTranslation) {
        this.#debugLog.log('info', 'pipeline', `Translation: "${fullTranslation.slice(0, 80)}"`);
        return fullTranslation;
      }
      return null;

    } catch (err) {
      this.#debugLog.log('error', 'pipeline', `Translation failed: ${err instanceof Error ? err.message : String(err)}`);
      this.#droppedUtterances++;
      return null;
    }
  }

  #buildTranslationPrompt(): string {
    const src = this.#sourceLanguage === 'auto' ? 'the detected language' : this.#sourceLanguage;
    return `You are a real-time speech translator. Translate from ${src} to ${this.#targetLanguage}. Output ONLY the translated text. No explanations, no brackets, no notes. Keep it concise and natural.`;
  }

  // ── REST TTS (replaces WebSocket TTS) ─────────────────────

  /**
   * Generate speech via ElevenLabs REST API and play it to BlackHole.
   * Simpler than WebSocket — no reconnect issues, no flush/isFinal dance.
   * Each call is independent — no shared state to corrupt.
   */
  async #speakWithRestTTS(text: string): Promise<void> {
    if (!text.trim()) return;

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.#voiceId}?output_format=pcm_24000`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.#apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: this.#voiceStability,
              similarity_boost: this.#voiceSimilarityBoost,
              style: this.#voiceStyle,
            },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!response.ok) {
        this.#debugLog.log('error', 'pipeline', `TTS REST error: ${response.status}`);
        return;
      }

      // Read the entire audio response
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      this.#debugLog.log('info', 'pipeline', `TTS REST: ${audioBuffer.length} bytes for "${text.slice(0, 40)}"`);

      if (audioBuffer.length > 0) {
        this.#latencyMonitor.markTTSFirstByte(this.#currentSequenceId);
        this.#emitStage(this.#currentSequenceId, 'SYNTHESIZED');

        // Resample 24kHz → 48kHz and write to BlackHole
        const resampled = this.#nativeAddon.resample(audioBuffer, 24000, 48000);
        this.#nativeAddon.writeVirtualMic(resampled);

        this.#emitStage(this.#currentSequenceId, 'PLAYED');
      }
    } catch (err) {
      this.#debugLog.log('error', 'pipeline', `TTS REST failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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

        // Flush any queued text from during reconnection — delay to let init message process
        if (this.#ttsTextQueue.length > 0) {
          const queuedText = this.#ttsTextQueue;
          this.#ttsTextQueue = '';
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              this.#debugLog.log('info', 'pipeline', `Flushing ${queuedText.length} queued chars to TTS`);
              ws.send(JSON.stringify({ text: queuedText }));
              ws.send(JSON.stringify({ text: '', flush: true }));
            }
          }, 500); // Wait 500ms for TTS to process init message
        }

        // Heartbeat
        this.#ttsHeartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(Buffer.alloc(0)); } catch(_e) {}
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
          // Don't auto-reconnect here — reconnect on demand when we have text to send
        }
      });
    });
  }

  #ttsSentChars = 0;
  #ttsTextQueue = '';
  #ttsFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Schedule a TTS flush after a short delay — batches multiple translations */
  #scheduleTTSFlush(): void {
    if (this.#ttsFlushTimer) clearTimeout(this.#ttsFlushTimer);
    this.#ttsFlushTimer = setTimeout(() => {
      this.#ttsFlushTimer = null;
      this.#flushTTS();
    }, 300); // Wait 300ms for more text before flushing
  }

  #sendTextToTTS(text: string): void {
    if (this.#ttsWs?.readyState === WebSocket.OPEN) {
      this.#ttsSentChars += text.length;
      this.#ttsWs.send(JSON.stringify({ text }));
    } else {
      // Queue text — TTS might be reconnecting
      this.#ttsTextQueue += text;
    }
  }

  #flushTTS(): void {
    if (this.#ttsWs?.readyState === WebSocket.OPEN) {
      this.#debugLog.log('info', 'pipeline', `TTS flush — sent ${this.#ttsSentChars} chars total`);
      this.#ttsWs.send(JSON.stringify({ text: '', flush: true }));
      this.#ttsSentChars = 0;
    } else if (this.#ttsTextQueue.length > 0) {
      // TTS not open — queue will be flushed when it reconnects
      this.#debugLog.log('info', 'pipeline', `TTS not open — ${this.#ttsTextQueue.length} chars queued for reconnect`);
    }
  }

  #ttsMessageCount = 0;

  #handleTTSMessage(data: Buffer | string): void {
    this.#ttsMessageCount++;

    const str = typeof data === 'string' ? data : data.toString('utf8');

    // Log first few messages for debugging
    if (this.#ttsMessageCount <= 5) {
      this.#debugLog.log('info', 'pipeline', `TTS msg #${this.#ttsMessageCount}: ${str.slice(0, 100)}`);
    }

    // Try JSON first — TTS sends base64 audio in JSON messages
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
        // TTS stream ended — will reconnect on demand for next utterance
      }

      return;
    } catch(_e) {
      // Not JSON — treat as raw binary PCM
    }

    // Raw binary audio fallback
    if (Buffer.isBuffer(data) && data.length > 100) {
      this.#debugLog.log('info', 'pipeline', `TTS raw binary: ${data.length} bytes`);
      this.#audioRouter.writeTTSAudio(data);
      this.#audioRouter.transitionRouting({ type: 'tts_start' });
    }
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
