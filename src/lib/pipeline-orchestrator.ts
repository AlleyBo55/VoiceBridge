/**
 * Central pipeline coordinator for VoiceBridge.
 * Replaces ad-hoc wiring in offscreen.ts with sequence-tracked utterance
 * lifecycle, strict playback ordering, backpressure, failure isolation,
 * audio routing, degradation cascading, and deterministic cleanup.
 */
import type {
  PipelineUtterance, PipelineStage, SessionState,
  AudioRoutingState, DegradationLevel, ServiceConnectionState,
} from './types.js';
import { AudioCaptureModule } from './audio-capture.js';
import { STTClient } from './stt-client.js';
import { TranslationEngine } from './translation-engine.js';
import { TTSClient } from './tts-client.js';
import { AudioOutputModule } from './audio-output.js';
import { EchoCancellationModule } from './echo-cancellation.js';
import { LatencyMonitor } from './latency-monitor.js';
import { transitionRoutingState, getEchoCancellationMode } from './audio-routing.js';
import { computeDegradationLevel, type ServiceHealth } from './degradation-manager.js';
import { buildPipelineCleanupTargets, executeCleanupSequence } from './cleanup-sequencer.js';
import { sendMessage } from './message-bus.js';
import { log } from './debug-log.js';
import { getSetting } from './settings-store.js';

export interface PipelineOrchestratorConfig {
  maxQueueSize: number;
  maxActiveUtterances: number;
  utteranceEvictionAgeSec: number;
  sttTimeoutMs: number;
  translationTimeoutMs: number;
  ttsTimeoutMs: number;
  latencyAlertThresholdMs: number;
  latencyAlertConsecutiveCount: number;
  reconnectSecondChanceDelayMs: number;
}
const DEFAULT_CONFIG: PipelineOrchestratorConfig = {
  maxQueueSize: 3, maxActiveUtterances: 10, utteranceEvictionAgeSec: 30,
  sttTimeoutMs: 5000, translationTimeoutMs: 3000, ttsTimeoutMs: 3000,
  latencyAlertThresholdMs: 3000, latencyAlertConsecutiveCount: 5,
  reconnectSecondChanceDelayMs: 30000,
};
const VALID_NEXT: Record<PipelineStage, PipelineStage[]> = {
  CAPTURED: ['TRANSCRIBED', 'DROPPED'], TRANSCRIBED: ['TRANSLATED', 'DROPPED'],
  TRANSLATED: ['SYNTHESIZED', 'DROPPED'], SYNTHESIZED: ['PLAYED', 'DROPPED'],
  PLAYED: [], DROPPED: [],
};
const DEG_ORDER: DegradationLevel[] = ['full', 'text-only', 'transcription-only', 'passthrough'];

/**
 * Central pipeline orchestrator. Tracks every utterance through
 * CAPTURED→TRANSCRIBED→TRANSLATED→SYNTHESIZED→PLAYED (or →DROPPED).
 * Enforces strict playback ordering, backpressure, failure isolation,
 * audio routing, degradation cascading, and deterministic cleanup.
 */
export class PipelineOrchestrator {
  #utterances = new Map<number, PipelineUtterance>();
  #currentSequenceId = 0;
  #playbackHead = 1;
  #audioCapture: AudioCaptureModule | null = null;
  #sttClient: STTClient | null = null;
  #translationEngine: TranslationEngine | null = null;
  #ttsClient: TTSClient | null = null;
  #audioOutput: AudioOutputModule | null = null;
  #echoCancellation: EchoCancellationModule | null = null;
  #latencyMonitor: LatencyMonitor | null = null;
  #routingState: AudioRoutingState = 'PASSTHROUGH';
  #degradationLevel: DegradationLevel = 'full';
  #serviceHealth: ServiceHealth = {
    stt: { status: 'disconnected' }, tts: { status: 'disconnected' }, llm: { status: 'disconnected' },
  };
  #upgradeTimer: ReturnType<typeof setTimeout> | null = null;
  #stageTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
  #consecutiveHighLatency = 0;
  #secondChanceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #sessionActive = false;
  #sessionStartedAt = 0;
  #totalUtterances = 0;
  #droppedUtterances = 0;
  #config: PipelineOrchestratorConfig;

  constructor(config?: Partial<PipelineOrchestratorConfig>) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start a new translation session — initializes modules, connects WebSockets, resets state. */
  async startSession(params: { sourceLanguage: string; targetLanguage: string }): Promise<void> {
    this.#currentSequenceId = 0; this.#playbackHead = 1; this.#utterances.clear();
    this.#consecutiveHighLatency = 0; this.#totalUtterances = 0; this.#droppedUtterances = 0;
    this.#sessionActive = true; this.#sessionStartedAt = Date.now();

    // Read all required settings
    const apiKey = await getSetting('elevenLabsApiKey');
    const llmApiKey = await getSetting('llmApiKey');
    const llmProvider = await getSetting('llmProvider');
    const openRouterModel = await getSetting('openRouterModel');
    const voiceId = await getSetting('voiceProfileId');
    const voiceStability = await getSetting('voiceStability');
    const voiceSimilarityBoost = await getSetting('voiceSimilarityBoost');
    const voiceStyle = await getSetting('voiceStyle');

    // Use a default ElevenLabs voice if no clone exists
    const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // "George" — built-in ElevenLabs voice
    const effectiveVoiceId = voiceId || DEFAULT_VOICE_ID;

    this.#latencyMonitor = new LatencyMonitor();
    this.#audioCapture = new AudioCaptureModule();
    this.#sttClient = new STTClient(apiKey);
    this.#translationEngine = new TranslationEngine({
      provider: llmProvider,
      apiKey: llmApiKey,
      openRouterModel,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
    });
    this.#ttsClient = new TTSClient();
    this.#audioOutput = new AudioOutputModule();
    this.#echoCancellation = new EchoCancellationModule({
      onMuteMic: () => this.#audioCapture?.mute(), onUnmuteMic: () => this.#audioCapture?.unmute(),
      onStopTTS: () => this.#audioOutput?.stopPlayback(), onFadeOutTTS: (ms) => this.#audioOutput?.fadeOut(ms),
      onStateChange: () => { /* tracked via routing */ },
    });

    // Initialize audio output and capture
    await this.#audioOutput.initialize();
    await this.#audioCapture.start();

    // Connect STT (Scribe v2 Realtime)
    await this.#sttClient.connect({ encoding: 'pcm_16000', languageCode: params.sourceLanguage, model: 'scribe_v2_realtime' });

    // Connect TTS (Flash v2.5 for lowest latency)
    await this.#ttsClient.connect({
      voiceId: effectiveVoiceId,
      modelId: 'eleven_flash_v2_5',
      outputFormat: 'pcm_24000',
      voiceSettings: {
        stability: voiceStability,
        similarityBoost: voiceSimilarityBoost,
        style: voiceStyle,
        useSpeakerBoost: true,
      },
      apiKey,
    });

    // Wire callbacks
    this.#audioCapture.onSpeechEnd = () => this.handleSpeechEnd();
    this.#audioCapture.onAudioChunk = (chunk) => this.#sttClient?.sendAudio(chunk);
    this.#sttClient.onFinalTranscript = (t) => this.handleFinalTranscript(t.sequenceId, t.text, t.language);
    this.#sttClient.onConnectionStateChange = (s) => this.handleServiceStateChange('stt', s);
    this.#ttsClient.onAudioChunk = (pcm, id) => this.handleTTSAudio(pcm, id);
    this.#ttsClient.onPlaybackEnd = (id) => this.handlePlaybackEnd(id);
    this.#ttsClient.onConnectionStateChange = (s) => this.handleServiceStateChange('tts', s);

    // Mark LLM as connected (it's HTTP, not WebSocket — always "connected" if key exists)
    if (llmApiKey) {
      this.handleServiceStateChange('llm', { status: 'connected' });
    }

    this.#transitionRouting({ type: 'session_start' }); this.#startHeartbeat(); this.#emitSessionState();
    log('info', 'pipeline', 'Session started', {
      source: params.sourceLanguage, target: params.targetLanguage,
      voiceId: effectiveVoiceId, llmProvider, hasVoiceClone: !!voiceId,
    });
  }

  /** Stop the current session — deterministic cleanup. */
  async stopSession(reason: string): Promise<void> {
    if (!this.#sessionActive) return;
    this.#sessionActive = false;
    log('info', 'pipeline', `Session stopping: ${reason}`);
    this.#transitionRouting({ type: 'session_stop' }); this.#clearAllTimers();
    await this.#executeCleanup(); this.#emitSessionState();
  }
  /** Called by AudioCaptureModule when VAD detects speech end. */
  handleSpeechEnd(): void {
    if (!this.#sessionActive) return;
    const seqId = ++this.#currentSequenceId;
    this.#utterances.set(seqId, { sequenceId: seqId, state: 'CAPTURED', capturedAt: Date.now(), audioChunks: [] });
    this.#totalUtterances++;
    this.#sttClient?.setSequenceId(seqId); this.#sttClient?.commit();
    this.#latencyMonitor?.markCaptureEnd(seqId);
    this.#setStageTimeout(seqId, 'stt', this.#config.sttTimeoutMs);
    this.#enforceBackpressure(); this.#evictCompletedUtterances();
    sendMessage('UTTERANCE_STATE_CHANGED', { sequenceId: seqId, state: 'CAPTURED' }); this.#emitSessionState();
  }
  /** Called by STTClient on final transcript. */
  handleFinalTranscript(sequenceId: number, text: string, language: string): void {
    const utt = this.#utterances.get(sequenceId);
    if (!utt || utt.state !== 'CAPTURED') return;
    this.#clearStageTimeout(sequenceId);
    this.#transitionUtterance(sequenceId, 'TRANSCRIBED');
    utt.transcript = text; utt.detectedLanguage = language;
    this.#latencyMonitor?.markSTTEnd(sequenceId);
    if (this.#degradationLevel === 'transcription-only' || this.#degradationLevel === 'passthrough') {
      this.#dropUtterance(sequenceId, `degraded-${this.#degradationLevel}`); return;
    }
    this.#setStageTimeout(sequenceId, 'translation', this.#config.translationTimeoutMs);
    this.#latencyMonitor?.markTranslationStart(sequenceId);
    if (this.#countUnprocessed() >= 2) log('warn', 'pipeline', 'Flushing translation due to backpressure');
    this.#translateUtterance(sequenceId, text);
  }
  /** Called by TranslationEngine as tokens stream. */
  handleTranslationToken(sequenceId: number, token: string): void {
    const utt = this.#utterances.get(sequenceId);
    if (!utt || utt.state === 'DROPPED') return;
    if (utt.state === 'TRANSCRIBED') { this.#clearStageTimeout(sequenceId); this.#latencyMonitor?.markTranslationFirstToken(sequenceId); }
    if (this.#degradationLevel === 'text-only') return;
    this.#ttsClient?.setSequenceId(sequenceId); this.#ttsClient?.sendText(token);
  }
  /** Called by TranslationEngine when translation completes. */
  handleTranslationComplete(sequenceId: number, fullText: string): void {
    const utt = this.#utterances.get(sequenceId);
    if (!utt || utt.state === 'DROPPED') return;
    this.#clearStageTimeout(sequenceId); this.#transitionUtterance(sequenceId, 'TRANSLATED');
    utt.translation = fullText;
    if (this.#degradationLevel !== 'full') { this.#dropUtterance(sequenceId, `degraded-${this.#degradationLevel}`); return; }
    this.#ttsClient?.flush(); this.#setStageTimeout(sequenceId, 'tts', this.#config.ttsTimeoutMs);
  }
  /** Called by TTSClient when audio chunk arrives. */
  handleTTSAudio(pcm: Int16Array, sequenceId: number): void {
    const utt = this.#utterances.get(sequenceId);
    if (!utt || utt.state === 'DROPPED') return;
    if (utt.state === 'TRANSLATED') {
      this.#clearStageTimeout(sequenceId); this.#latencyMonitor?.markTTSFirstByte(sequenceId);
      this.#transitionUtterance(sequenceId, 'SYNTHESIZED');
    }
    utt.audioChunks.push(pcm.buffer as ArrayBuffer); this.#advancePlayback();
  }
  /** Called by AudioOutputModule when playback finishes. */
  handlePlaybackEnd(sequenceId: number): void {
    const utt = this.#utterances.get(sequenceId);
    if (!utt || utt.state === 'DROPPED') return;
    this.#transitionUtterance(sequenceId, 'PLAYED'); this.#transitionRouting({ type: 'tts_end' });
    this.#latencyMonitor?.markPlaybackStart(sequenceId);
    const m = this.#latencyMonitor?.getMeasurement(sequenceId);
    if (m) {
      if (m.totalMs > this.#config.latencyAlertThresholdMs) {
        this.#consecutiveHighLatency++;
        if (this.#consecutiveHighLatency >= this.#config.latencyAlertConsecutiveCount)
          sendMessage('ERROR', { code: 'high-latency', message: `${this.#consecutiveHighLatency} consecutive high-latency utterances`, userMessage: 'Translation latency is high. Check your network or reduce quality settings.' });
      } else { this.#consecutiveHighLatency = 0; }
      sendMessage('LATENCY_UPDATE', m);
    }
    this.#playbackHead = sequenceId + 1; this.#advancePlayback(); this.#emitSessionState();
  }
  /** Called by service health monitors. */
  handleServiceStateChange(service: 'stt' | 'tts' | 'llm', state: ServiceConnectionState): void {
    this.#serviceHealth[service] = state;
    sendMessage('CONNECTION_STATE_CHANGED', { service, state }); this.#evaluateDegradation(service);
    if (state.status === 'error' && 'retryable' in state && !state.retryable) this.#scheduleSecondChance(service);
  }
  /** Get current routing state for the content script. */
  getRoutingState(): AudioRoutingState { return this.#routingState; }
  /** Get current degradation level. */
  getDegradationLevel(): DegradationLevel { return this.#degradationLevel; }

  #transitionUtterance(sequenceId: number, to: PipelineStage): void {
    const utt = this.#utterances.get(sequenceId);
    if (!utt || !VALID_NEXT[utt.state]?.includes(to)) return;
    const from = utt.state; utt.state = to;
    sendMessage('UTTERANCE_STATE_CHANGED', { sequenceId, state: to });
    log('info', 'pipeline', `Utterance ${sequenceId}: ${from}→${to}`);
  }
  #dropUtterance(sequenceId: number, reason: string): void {
    const utt = this.#utterances.get(sequenceId);
    if (!utt || utt.state === 'PLAYED' || utt.state === 'DROPPED') return;
    this.#clearStageTimeout(sequenceId);
    utt.droppedReason = reason; utt.state = 'DROPPED'; this.#droppedUtterances++;
    sendMessage('UTTERANCE_STATE_CHANGED', { sequenceId, state: 'DROPPED', reason });
    log('warn', 'pipeline', `Utterance ${sequenceId} dropped: ${reason}`);
    if (sequenceId === this.#playbackHead) { this.#playbackHead = sequenceId + 1; this.#advancePlayback(); }
    this.#emitSessionState();
  }
  #enforceBackpressure(): void {
    const q = [...this.#utterances.values()].filter(u => u.state === 'CAPTURED' || u.state === 'TRANSCRIBED').sort((a, b) => a.sequenceId - b.sequenceId);
    while (q.length > this.#config.maxQueueSize) { const o = q.shift(); if (o) this.#dropUtterance(o.sequenceId, 'backpressure'); }
  }
  #canPlay(seqId: number): boolean {
    if (seqId <= 0) return false; if (seqId === 1) return true;
    const p = this.#utterances.get(seqId - 1);
    return !p || p.state === 'PLAYED' || p.state === 'DROPPED';
  }
  #advancePlayback(): void {
    const utt = this.#utterances.get(this.#playbackHead);
    if (!utt) return;
    if (utt.state === 'DROPPED') { this.#playbackHead++; this.#advancePlayback(); return; }
    if (utt.state === 'SYNTHESIZED' && this.#canPlay(this.#playbackHead)) {
      this.#transitionRouting({ type: 'tts_start' });
      if (this.#audioOutput && utt.audioChunks.length > 0)
        for (const buf of utt.audioChunks) void this.#audioOutput.playAudio(new Int16Array(buf), utt.sequenceId);
    }
  }
  #evictCompletedUtterances(): void {
    const now = Date.now(); const maxAge = this.#config.utteranceEvictionAgeSec * 1000;
    for (const [id, u] of this.#utterances)
      if ((u.state === 'PLAYED' || u.state === 'DROPPED') && (now - u.capturedAt) > maxAge) this.#utterances.delete(id);
    while (this.#utterances.size > this.#config.maxActiveUtterances) this.#utterances.delete(Math.min(...this.#utterances.keys()));
  }
  #countUnprocessed(): number {
    let c = 0; for (const u of this.#utterances.values()) if (u.state === 'CAPTURED' || u.state === 'TRANSCRIBED') c++; return c;
  }
  #setStageTimeout(seqId: number, stage: string, ms: number): void {
    const key = seqId * 100 + (stage === 'stt' ? 1 : stage === 'translation' ? 2 : 3);
    this.#clearStageTimeout(seqId);
    this.#stageTimeouts.set(key, setTimeout(() => { this.#stageTimeouts.delete(key); this.#dropUtterance(seqId, `timeout-${stage}`); }, ms));
  }
  #clearStageTimeout(seqId: number): void {
    for (const off of [1, 2, 3]) { const k = seqId * 100 + off, t = this.#stageTimeouts.get(k); if (t) { clearTimeout(t); this.#stageTimeouts.delete(k); } }
  }
  #transitionRouting(event: { type: string }): void {
    const prev = this.#routingState;
    const next = transitionRoutingState(prev, event as Parameters<typeof transitionRoutingState>[1]);
    if (next === prev) return;
    this.#routingState = next;
    sendMessage('AUDIO_ROUTING_STATE_CHANGED', { state: next });
    const ecMode = getEchoCancellationMode(next);
    if (ecMode === 'speaking') this.#echoCancellation?.handleEvent({ type: 'tts_start' });
    else this.#echoCancellation?.handleEvent({ type: 'tts_end' });
    log('info', 'state', `Routing: ${prev}→${next}`);
  }
  #evaluateDegradation(trigger: string): void {
    const computed = computeDegradationLevel(this.#serviceHealth);
    if (computed === this.#degradationLevel) return;
    if (DEG_ORDER.indexOf(computed) > DEG_ORDER.indexOf(this.#degradationLevel)) {
      const nd = DEG_ORDER[DEG_ORDER.indexOf(this.#degradationLevel) + 1];
      if (nd && nd !== computed) { this.#applyDegradation(nd, trigger); return; }
    }
    this.#applyDegradation(computed, trigger);
  }
  #applyDegradation(level: DegradationLevel, trigger: string): void {
    const prev = this.#degradationLevel; this.#degradationLevel = level;
    if (level !== 'full' && prev === 'full') this.#transitionRouting({ type: 'degraded_to_passthrough' });
    sendMessage('DEGRADATION_LEVEL_CHANGED', { level, previous: prev, trigger });
    log('warn', 'pipeline', `Degradation: ${prev}→${level}`, { trigger });
  }
  #attemptUpgrade(): void {
    if (this.#upgradeTimer) return;
    this.#upgradeTimer = setTimeout(() => {
      this.#upgradeTimer = null;
      const c = computeDegradationLevel(this.#serviceHealth);
      if (c !== this.#degradationLevel) this.#applyDegradation(c, 'service-recovery');
    }, 5000);
  }
  async #executeCleanup(): Promise<void> {
    const targets = buildPipelineCleanupTargets({
      audioCapture: this.#audioCapture, sttClient: this.#sttClient, translationEngine: this.#translationEngine,
      ttsClient: this.#ttsClient, audioOutput: this.#audioOutput, echoCancellation: this.#echoCancellation, latencyMonitor: this.#latencyMonitor,
    });
    const result = await executeCleanupSequence(targets);
    this.#audioCapture = null; this.#sttClient = null; this.#translationEngine = null;
    this.#ttsClient = null; this.#audioOutput = null; this.#echoCancellation = null; this.#latencyMonitor = null;
    sendMessage('CLEANUP_COMPLETE', { errors: result.errors.map(e => ({ name: e.name, message: e.error.message })) });
    if (!result.success) log('warn', 'pipeline', 'Cleanup had errors', { count: result.errors.length });
  }
  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#sessionActive) return;
      this.#evaluateDegradation('heartbeat-check');
      const c = computeDegradationLevel(this.#serviceHealth);
      if (c !== this.#degradationLevel && DEG_ORDER.indexOf(c) < DEG_ORDER.indexOf(this.#degradationLevel)) this.#attemptUpgrade();
    }, 2000);
  }
  #scheduleSecondChance(service: string): void {
    if (this.#secondChanceTimers.has(service)) return;
    this.#secondChanceTimers.set(service, setTimeout(() => {
      this.#secondChanceTimers.delete(service);
      log('info', 'connection', `Second-chance reconnection for ${service}`);
      setTimeout(() => {
        const h = this.#serviceHealth[service as keyof ServiceHealth];
        if (h.status === 'error') {
          log('error', 'connection', `Second-chance failed for ${service}`);
          sendMessage('ERROR', { code: 'reconnection-failed', message: `${service} reconnection failed`, userMessage: `Connection to ${service} lost. Check your network and try resuming.` });
        }
      }, this.#config.reconnectSecondChanceDelayMs);
    }, this.#config.reconnectSecondChanceDelayMs));
  }
  async #translateUtterance(seqId: number, text: string): Promise<void> {
    if (!this.#translationEngine) return;
    try {
      const t = { text, language: this.#utterances.get(seqId)?.detectedLanguage ?? '', isFinal: true as const, sequenceId: seqId, timestamp: Date.now() };
      let full = '';
      for await (const tok of this.#translationEngine.translate(t)) { this.handleTranslationToken(seqId, tok); full += tok; }
      this.handleTranslationComplete(seqId, full);
    } catch (err) {
      log('error', 'pipeline', `Translation failed for ${seqId}`, { error: err instanceof Error ? err.message : String(err) });
      this.#dropUtterance(seqId, 'translation-error');
    }
  }
  #emitSessionState(): void {
    sendMessage('SESSION_STATE_CHANGED', {
      active: this.#sessionActive, startedAt: this.#sessionStartedAt, sourceLanguage: '', targetLanguage: '',
      totalUtterances: this.#totalUtterances, droppedUtterances: this.#droppedUtterances, currentSequenceId: this.#currentSequenceId,
      voiceTimeMs: 0, ttsCharactersUsed: 0, sttSecondsUsed: 0, llmTokensUsed: 0,
    } satisfies SessionState);
  }
  #clearAllTimers(): void {
    for (const t of this.#stageTimeouts.values()) clearTimeout(t); this.#stageTimeouts.clear();
    for (const t of this.#secondChanceTimers.values()) clearTimeout(t); this.#secondChanceTimers.clear();
    if (this.#heartbeatTimer) { clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = null; }
    if (this.#upgradeTimer) { clearTimeout(this.#upgradeTimer); this.#upgradeTimer = null; }
  }
}
