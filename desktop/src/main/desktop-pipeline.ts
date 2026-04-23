/**
 * Desktop pipeline — FULL end-to-end wiring.
 *
 * Mic → STT (ElevenLabs Scribe) → Translation (LLM) → TTS (ElevenLabs REST) → BlackHole
 *
 * This replaces the Chrome extension's offscreen document pipeline.
 * All WebSocket and HTTP calls happen in the Electron main process.
 * Audio capture uses the native addon (ffmpeg for real mic, mock fallback).
 */

import type { BrowserWindow } from 'electron';
import type { NativeAudioAddon } from '../native/native-addon.js';
import type {
  VADState, ServiceConnectionState, PipelineStage,
} from '../shared/types.js';
import { AudioRouter, computeRmsDb } from './audio-router.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { sendToRenderer } from './electron-ipc.js';
import { DesktopDebugLog } from './desktop-debug-log.js';
import { DesktopLatencyMonitor } from './desktop-latency.js';

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
const HEARTBEAT_INTERVAL_MS = 15000;

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

  // STT WebSocket
  #sttWs: WsSocket | null = null;
  #sttHeartbeat: ReturnType<typeof setInterval> | null = null;

  // Push-to-talk: when enabled, audio only goes to STT while PTT is held
  #pttEnabled = false;
  #pttActive = false; // true = button held down, sending audio

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
    this.#lastTranslatedTexts.clear();
    this.#utteranceQueue = [];
    this.#processingUtterance = false;
    this.#sttMessageCount = 0;
    this.#lastSttMessageAt = 0;
    if (this.#sttWatchdog) { clearInterval(this.#sttWatchdog); this.#sttWatchdog = null; }

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

    // 2. LLM + TTS use REST APIs — no persistent connections needed
    if (this.#llmApiKey) {
      this.#emitConnectionState('llm', { status: 'connected' });
    }
    this.#emitConnectionState('tts', { status: 'connected' });

    // 3. Start audio capture
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
    this.#pttEnabled = (await this.#settings.get('pushToTalk')) === true;
    this.#pttActive = false;
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

    // Start STT watchdog — reconnect if no messages for 10s
    // Only active in VAD mode (PTT off). In PTT mode, silence between presses is normal.
    this.#sttWatchdog = setInterval(() => {
      if (!this.#sessionActive) return;
      // Skip watchdog in PTT mode — silence is expected when not pressing
      if (this.#pttEnabled) return;
      const silentMs = Date.now() - this.#lastSttMessageAt;
      if (this.#lastSttMessageAt > 0 && silentMs > 10000 && this.#sttWs) {
        this.#debugLog.log('warn', 'connection', `STT silent for ${(silentMs / 1000).toFixed(0)}s — forcing reconnect`);
        try { this.#sttWs.close(); } catch(_e) {}
        this.#sttWs = null;
      }
    }, 3000);

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
    if ('destroy' in this.#nativeAddon) {
      (this.#nativeAddon as { destroy(): void }).destroy();
    }

    // Disconnect STT
    if (this.#sttWs) {
      try { this.#sttWs.close(); } catch(_e) {}
      this.#sttWs = null;
    }
    if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }
    if (this.#sttWatchdog) { clearInterval(this.#sttWatchdog); this.#sttWatchdog = null; }

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

  /** Enable/disable push-to-talk mode */
  setPTTEnabled(enabled: boolean): void {
    this.#pttEnabled = enabled;
    this.#pttActive = false;
    this.#debugLog.log('info', 'pipeline', `PTT mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /** Press PTT — start sending audio to STT */
  pttPress(): void {
    if (!this.#sessionActive || !this.#pttEnabled) return;
    if (this.#pttActive) return; // Already pressed
    this.#pttActive = true;
    this.#debugLog.log('info', 'pipeline', 'PTT pressed — mic open');

    // Connect STT on press if not already connected
    if (!this.#sttWs || this.#sttWs.readyState !== WS.OPEN) {
      this.#connectSTT();
    }
  }

  /** Release PTT — commit and stop sending audio */
  pttRelease(): void {
    if (!this.#sessionActive || !this.#pttEnabled) return;
    if (!this.#pttActive) return; // Already released — prevent double commit
    this.#pttActive = false;
    this.#commitSTT();
    this.#debugLog.log('info', 'pipeline', 'PTT released — mic closed');
    // Close STT after committed transcript arrives.
    // The close handler won't auto-reconnect because #pttActive is false.
    setTimeout(() => {
      if (this.#sessionActive && this.#pttEnabled && !this.#pttActive && this.#sttWs) {
        this.#debugLog.log('info', 'connection', 'PTT idle — closing STT until next press');
        try { this.#sttWs.close(); } catch(_e) {}
        this.#sttWs = null;
      }
    }, 2000); // Wait 2s for committed_transcript to arrive
  }

  isPTTEnabled(): boolean { return this.#pttEnabled; }

  // ── STT Connection ────────────────────────────────────────

  async #connectSTT(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Pass config via query params — language, format, and VAD commit strategy
      const langParam = this.#sourceLanguage !== 'auto' ? `&language_code=${this.#sourceLanguage}` : '';
      // Use manual commit when PTT is on (we commit on release), VAD commit when PTT is off
      const commitStrategy = this.#pttEnabled ? 'manual' : 'vad';
      const vadParams = this.#pttEnabled ? '' : '&vad_threshold=0.2&vad_silence_threshold_secs=0.8';
      const url = `${STT_ENDPOINT}?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=${commitStrategy}${vadParams}${langParam}`;
      this.#debugLog.log('info', 'connection', `STT URL: ${url.replace(/xi-api-key=[^&]+/, 'xi-api-key=***')}`);
      const ws = new WS(url, {
        headers: { 'xi-api-key': this.#apiKey },
      });
      this.#sttWs = ws;

      ws.on('open', () => {
        this.#emitConnectionState('stt', { status: 'connected' });
        this.#debugLog.log('info', 'connection', 'STT connected');

        this.#sttHeartbeat = setInterval(() => {
          if (ws.readyState === WS.OPEN) {
            try { ws.send(Buffer.alloc(0)); } catch(_e) {}
          }
        }, HEARTBEAT_INTERVAL_MS);

        resolve();
      });

      ws.on('message', (...args: unknown[]) => {
        const data = args[0] as Buffer | string;
        this.#handleSTTMessage(typeof data === 'string' ? data : data.toString());
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
        this.#debugLog.log('warn', 'connection', `STT closed: code=${code ?? '?'} reason="${reason ?? ''}"` );
        if (this.#sttHeartbeat) { clearInterval(this.#sttHeartbeat); this.#sttHeartbeat = null; }
        this.#sttWs = null;
        if (this.#sessionActive) {
          this.#emitConnectionState('stt', { status: 'disconnected' });
          // In PTT mode: don't auto-reconnect if we closed intentionally (idle between presses)
          // or if PTT is not currently pressed (server closed idle connection)
          if (this.#pttEnabled && !this.#pttActive) {
            this.#debugLog.log('info', 'connection', 'STT closed (PTT idle) — will reconnect on next press');
            return;
          }
          // Auto-reconnect after 500ms
          this.#debugLog.log('info', 'connection', 'STT auto-reconnecting in 500ms...');
          setTimeout(() => {
            if (this.#sessionActive && !this.#sttWs) {
              this.#connectSTT();
            }
          }, 500);
        }
      });
    });
  }

  #sendAudioToSTT(chunk: Int16Array): void {
    // PTT gate: if push-to-talk is enabled, only send when button is held
    if (this.#pttEnabled && !this.#pttActive) return;

    if (this.#sttWs?.readyState === WS.OPEN) {
      this.#sttWs.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: pcmToBase64(chunk),
        commit: false,
        sample_rate: 16000,
      }));
    }
  }

  /** Send a commit signal to STT — forces finalization of current transcript */
  #commitSTT(): void {
    if (this.#sttWs?.readyState === WS.OPEN) {
      this.#sttWs.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        commit: true,
        sample_rate: 16000,
      }));
      this.#debugLog.log('info', 'pipeline', 'STT commit sent');
    }
  }

  // ── STT State ─────────────────────────────────────────────

  #lastTranslatedTexts = new Set<string>();

  #sttMessageCount = 0;
  #lastSttMessageAt = 0;
  #sttWatchdog: ReturnType<typeof setInterval> | null = null;

  #handleSTTMessage(data: string): void {
    this.#sttMessageCount++;
    this.#lastSttMessageAt = Date.now();
    try {
      const msg = JSON.parse(data) as Record<string, unknown>;
      const msgType = (msg['message_type'] ?? msg['type'] ?? 'unknown') as string;
      const text = (msg['text'] ?? '') as string;

      // Log ALL messages for debugging (first 20 + every 10th after)
      if (this.#sttMessageCount <= 20 || this.#sttMessageCount % 10 === 0) {
        this.#debugLog.log('info', 'pipeline', `STT msg #${this.#sttMessageCount}: ${msgType} "${(text || '').slice(0, 60)}"`);
      }

      // Log session_started and all error types
      if (msgType === 'session_started') {
        this.#debugLog.log('info', 'connection', `STT session started: ${JSON.stringify(msg['config'] ?? {}).slice(0, 120)}`);
        return;
      }

      if (msgType.includes('error') || msgType === 'quota_exceeded' || msgType === 'rate_limited' || msgType === 'auth_error') {
        this.#debugLog.log('error', 'pipeline', `STT ${msgType}: ${JSON.stringify(msg['error'] ?? msg).slice(0, 200)}`);
        return;
      }

      // commit_throttled = we sent too many commits too fast. Just ignore it.
      if (msgType === 'commit_throttled') {
        this.#debugLog.log('warn', 'pipeline', 'STT commit throttled — too many commits');
        return;
      }

      // Show partials in UI but don't translate them — wait for committed transcript
      if (msgType === 'partial_transcript' && text) {
        this.#mainWindow?.webContents?.send('pipeline:partial-transcript', { text });
      }

      // Committed transcripts are the authoritative trigger for translation.
      // Server-side VAD commits automatically, our #commitSTT() on speech-end is backup.
      if (msgType === 'committed_transcript' || msgType === 'committed_transcript_with_timestamps') {
        const committedText = text.trim();
        if (!committedText) return;

        // Content-based dedup
        if (this.#lastTranslatedTexts.has(committedText)) {
          this.#debugLog.log('info', 'pipeline', `Skipping duplicate commit: "${committedText.slice(0, 40)}"`);
          return;
        }
        this.#lastTranslatedTexts.add(committedText);
        if (this.#lastTranslatedTexts.size > 50) {
          const first = this.#lastTranslatedTexts.values().next().value;
          if (first) this.#lastTranslatedTexts.delete(first);
        }

        this.#debugLog.log('info', 'pipeline', `STT committed: "${committedText.slice(0, 80)}"`);
        this.#latencyMonitor.markSTTEnd(this.#currentSequenceId);
        this.#emitStage(this.#currentSequenceId, 'TRANSCRIBED');
        this.#enqueueUtterance(committedText, this.#currentSequenceId);
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
    // Only commit from VAD when PTT is disabled — PTT release handles its own commit
    if (!this.#pttEnabled) {
      this.#commitSTT();
    }
    this.#debugLog.log('info', 'pipeline', `Utterance ${this.#currentSequenceId} captured`);
  }

  // ── Utterance Queue (like OBS frame buffer) ───────────────

  #utteranceQueue: Array<{ text: string; seqId: number }> = [];
  #processingUtterance = false;

  #enqueueUtterance(text: string, seqId: number): void {
    this.#utteranceQueue.push({ text, seqId });
    this.#debugLog.log('info', 'pipeline', `Queued utterance #${seqId} (${this.#utteranceQueue.length} in queue)`);
    this.#processNextUtterance();
  }

  async #processNextUtterance(): Promise<void> {
    if (this.#processingUtterance) return;
    if (this.#utteranceQueue.length === 0) return;
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
    if (this.#sessionActive) {
      this.#processNextUtterance();
    }
  }

  // ── Translation ───────────────────────────────────────────

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
        return null;
      }

      const reader = response.body?.getReader();
      if (!reader) return null;

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
          } catch(_e) { /* skip malformed */ }
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

  // ── REST TTS ──────────────────────────────────────────────

  /**
   * Generate speech via ElevenLabs REST API and play it to BlackHole.
   * Each call is independent — no shared state to corrupt.
   */
  async #speakWithRestTTS(text: string): Promise<void> {
    if (!text.trim()) return;

    // Always read the latest voice ID — user may have changed it mid-session
    const currentVoiceId = await this.#settings.get('voiceProfileId');
    if (currentVoiceId) {
      this.#voiceId = currentVoiceId;
    }

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

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      this.#debugLog.log('info', 'pipeline', `TTS REST: ${audioBuffer.length} bytes for "${text.slice(0, 40)}"`);

      if (audioBuffer.length > 0) {
        this.#latencyMonitor.markTTSFirstByte(this.#currentSequenceId);
        this.#emitStage(this.#currentSequenceId, 'SYNTHESIZED');

        // Pass raw 24kHz PCM directly — ffmpeg handles resampling to 48kHz in writeVirtualMic
        this.#nativeAddon.writeVirtualMic(audioBuffer, 24000);

        this.#emitStage(this.#currentSequenceId, 'PLAYED');
      }
    } catch (err) {
      this.#debugLog.log('error', 'pipeline', `TTS REST failed: ${err instanceof Error ? err.message : String(err)}`);
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
