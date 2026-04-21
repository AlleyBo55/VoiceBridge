/**
 * Offscreen document — persistent pipeline host.
 * Manages WebSocket connections, audio processing, and the full translation pipeline.
 * This context survives service worker termination.
 */

import { initMessageBus, sendMessage, onMessage } from '../lib/message-bus.js';
import { getSetting } from '../lib/settings-store.js';
import { AudioCaptureModule } from '../lib/audio-capture.js';
import { STTClient } from '../lib/stt-client.js';
import { TranslationEngine } from '../lib/translation-engine.js';
import { TTSClient } from '../lib/tts-client.js';
import { AudioOutputModule } from '../lib/audio-output.js';
import { EchoCancellationModule } from '../lib/echo-cancellation.js';
import { LatencyMonitor } from '../lib/latency-monitor.js';
import { log } from '../lib/debug-log.js';

// ── Pipeline Components ─────────────────────────────────────

let audioCapture: AudioCaptureModule | null = null;
let sttClient: STTClient | null = null;
let translationEngine: TranslationEngine | null = null;
let ttsClient: TTSClient | null = null;
let audioOutput: AudioOutputModule | null = null;
let echoCancellation: EchoCancellationModule | null = null;
let latencyMonitor: LatencyMonitor | null = null;

let voiceTimeAccumulator = 0;
let voiceTimeStart = 0;
let isSpeaking = false;

// ── Initialize ──────────────────────────────────────────────

async function init(): Promise<void> {
  initMessageBus();
  log('info', 'pipeline', 'Offscreen document initialized');

  onMessage('SESSION_START', handleSessionStart);
  onMessage('SESSION_STOP', handleSessionStop);
  onMessage('LANGUAGE_CHANGED', ({ sourceLanguage, targetLanguage }) => {
    translationEngine?.setLanguagePair(sourceLanguage, targetLanguage);
  });
  onMessage('GHOST_MODE_TOGGLE', ({ enabled }) => {
    audioCapture?.setGhostMode(enabled);
    echoCancellation?.setGhostMode(enabled);
  });
}

// ── Session Lifecycle ───────────────────────────────────────

async function handleSessionStart(payload: { sourceLanguage: string; targetLanguage: string }): Promise<void> {
  log('info', 'pipeline', 'Starting session', payload);

  const apiKey = await getSetting('elevenLabsApiKey');
  const llmApiKey = await getSetting('llmApiKey');
  const llmProvider = await getSetting('llmProvider');
  const voiceId = await getSetting('voiceProfileId');

  // Initialize latency monitor
  latencyMonitor = new LatencyMonitor();
  latencyMonitor.onLatencyUpdate = (measurement) => {
    sendMessage('LATENCY_UPDATE', measurement);
  };

  // Initialize audio output
  audioOutput = new AudioOutputModule();
  await audioOutput.initialize();

  // Initialize echo cancellation
  echoCancellation = new EchoCancellationModule({
    onMuteMic: () => audioCapture?.mute(),
    onUnmuteMic: () => audioCapture?.unmute(),
    onStopTTS: () => ttsClient?.cancel(),
    onFadeOutTTS: (ms) => audioOutput?.fadeOut(ms),
    onStateChange: (state) => sendMessage('ECHO_STATE_CHANGED', { state }),
  });

  // Initialize STT client
  sttClient = new STTClient(apiKey);
  sttClient.onPartialTranscript = (transcript) => {
    sendMessage('STT_TRANSCRIPT_PARTIAL', {
      text: transcript.text,
      language: transcript.language,
      sequenceId: transcript.sequenceId,
    });
  };
  sttClient.onFinalTranscript = async (transcript) => {
    latencyMonitor?.markSTTEnd(transcript.sequenceId);
    sendMessage('STT_TRANSCRIPT_FINAL', {
      text: transcript.text,
      language: transcript.language,
      sequenceId: transcript.sequenceId,
    });

    // Forward to translation
    if (translationEngine) {
      latencyMonitor?.markTranslationStart(transcript.sequenceId);
      let firstToken = true;
      const tokens: string[] = [];

      for await (const token of translationEngine.translate(transcript)) {
        if (firstToken) {
          latencyMonitor?.markTranslationFirstToken(transcript.sequenceId);
          firstToken = false;
        }
        tokens.push(token);
        ttsClient?.sendText(token);
        sendMessage('TRANSLATION_PARTIAL', { text: tokens.join(''), sequenceId: transcript.sequenceId });
      }

      ttsClient?.flush();
      sendMessage('TRANSLATION_FINAL', { text: tokens.join(''), sequenceId: transcript.sequenceId });
    }
  };
  sttClient.onConnectionStateChange = (state) => {
    sendMessage('CONNECTION_STATE_CHANGED', { service: 'stt', state });
  };

  await sttClient.connect({
    encoding: 'pcm_16000',
    languageCode: payload.sourceLanguage,
    model: 'scribe_v1',
  });

  // Initialize translation engine
  translationEngine = new TranslationEngine({
    provider: llmProvider,
    apiKey: llmApiKey,
    sourceLanguage: payload.sourceLanguage,
    targetLanguage: payload.targetLanguage,
  });

  // Initialize TTS client
  ttsClient = new TTSClient();
  ttsClient.onAudioChunk = (pcm, sequenceId) => {
    latencyMonitor?.markTTSFirstByte(sequenceId);
    echoCancellation?.handleEvent({ type: 'tts_start' });
    audioOutput?.playAudio(pcm, sequenceId);
    latencyMonitor?.markPlaybackStart(sequenceId);
  };
  ttsClient.onPlaybackEnd = () => {
    echoCancellation?.handleEvent({ type: 'tts_end' });
  };
  ttsClient.onConnectionStateChange = (state) => {
    sendMessage('CONNECTION_STATE_CHANGED', { service: 'tts', state });
  };

  if (voiceId) {
    await ttsClient.connect({
      voiceId,
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'pcm_24000',
      voiceSettings: {
        stability: await getSetting('voiceStability'),
        similarityBoost: await getSetting('voiceSimilarityBoost'),
        style: await getSetting('voiceStyle'),
        useSpeakerBoost: true,
      },
      apiKey,
    });
  }

  // Initialize audio capture
  audioCapture = new AudioCaptureModule();
  audioCapture.onAudioChunk = (chunk, sequenceId) => {
    latencyMonitor?.markCaptureStart(sequenceId);
    sttClient?.sendAudio(chunk);
    sttClient?.setSequenceId(sequenceId);
    latencyMonitor?.markCaptureEnd(sequenceId);
  };
  audioCapture.onVADStateChange = (state) => {
    sendMessage('AUDIO_LEVEL', { rmsDb: audioCapture?.getCurrentLevel() ?? -Infinity, vadState: state.status });

    // Track voice time for demo quota
    if (state.status === 'speech' && !isSpeaking) {
      isSpeaking = true;
      voiceTimeStart = Date.now();
    } else if (state.status === 'silence' && isSpeaking) {
      isSpeaking = false;
      voiceTimeAccumulator += Date.now() - voiceTimeStart;
      sendMessage('DEMO_TIME_UPDATE', {
        voiceTimeUsedMs: voiceTimeAccumulator,
        voiceTimeRemainingMs: Math.max(0, 120000 - voiceTimeAccumulator),
      });

      if (voiceTimeAccumulator >= 120000) {
        sendMessage('DEMO_LIMIT_REACHED', { resetsAt: Date.now() + 86400000 });
        handleSessionStop({ reason: 'demo-limit' });
      }
    }
  };
  audioCapture.onSpeechEnd = () => {
    sttClient?.commit();
  };

  await audioCapture.start();

  sendMessage('SESSION_STATE_CHANGED', {
    active: true,
    startedAt: Date.now(),
    sourceLanguage: payload.sourceLanguage,
    targetLanguage: payload.targetLanguage,
    totalUtterances: 0,
    droppedUtterances: 0,
    currentSequenceId: 0,
    voiceTimeMs: 0,
    ttsCharactersUsed: 0,
    sttSecondsUsed: 0,
    llmTokensUsed: 0,
  });

  log('info', 'pipeline', 'Session started');
}

async function handleSessionStop(_payload: { reason: string }): Promise<void> {
  log('info', 'pipeline', 'Stopping session', _payload);

  await audioCapture?.stop();
  audioCapture = null;

  await sttClient?.disconnect();
  sttClient = null;

  translationEngine?.destroy();
  translationEngine = null;

  await ttsClient?.disconnect();
  ttsClient = null;

  await audioOutput?.destroy();
  audioOutput = null;

  echoCancellation?.destroy();
  echoCancellation = null;

  latencyMonitor?.clear();
  latencyMonitor = null;

  voiceTimeAccumulator = 0;
  isSpeaking = false;

  sendMessage('SESSION_STATE_CHANGED', {
    active: false,
    startedAt: 0,
    sourceLanguage: '',
    targetLanguage: '',
    totalUtterances: 0,
    droppedUtterances: 0,
    currentSequenceId: 0,
    voiceTimeMs: 0,
    ttsCharactersUsed: 0,
    sttSecondsUsed: 0,
    llmTokensUsed: 0,
  });

  log('info', 'pipeline', 'Session stopped');
}

// ── Boot ────────────────────────────────────────────────────

init();
