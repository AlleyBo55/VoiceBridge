/**
 * Offscreen document — persistent pipeline host.
 * Delegates all pipeline complexity to PipelineOrchestrator.
 * Manages AudioBridgeSender for zero-copy audio transfer to content script.
 */

import { initMessageBus, sendMessage, onMessage } from '../lib/message-bus.js';
import { PipelineOrchestrator } from '../lib/pipeline-orchestrator.js';
import { AudioBridgeSender } from '../lib/audio-bridge.js';
import { log } from '../lib/debug-log.js';

// ── Pipeline ────────────────────────────────────────────────

const orchestrator = new PipelineOrchestrator();
const audioBridgeSender = new AudioBridgeSender();

// Demo limit config from build env
const DEMO_UNLIMITED = import.meta.env.VITE_DEMO_UNLIMITED === 'true';
const DEMO_VOICE_LIMIT_MS = Number(import.meta.env.VITE_DEMO_VOICE_LIMIT_SECONDS ?? '300') * 1000;

let voiceTimeAccumulator = 0;
let voiceTimeStart = 0;
let isSpeaking = false;

// ── Initialize ──────────────────────────────────────────────

function init(): void {
  initMessageBus();
  log('info', 'pipeline', 'Offscreen document initialized');
  console.log('[VB:offscreen] Offscreen document initialized');

  onMessage('SESSION_START', handleSessionStart);
  onMessage('SESSION_STOP', handleSessionStop);

  onMessage('LANGUAGE_CHANGED', ({ sourceLanguage, targetLanguage }) => {
    log('info', 'pipeline', 'Language changed', { sourceLanguage, targetLanguage });
  });

  onMessage('GHOST_MODE_TOGGLE', ({ enabled }) => {
    log('info', 'pipeline', `Ghost mode ${enabled ? 'enabled' : 'disabled'}`);
  });

  // Voice time tracking via VAD state from AUDIO_LEVEL messages
  onMessage('AUDIO_LEVEL', ({ vadState }) => {
    trackVoiceTime(vadState);
  });

  // Listen for MessagePort from service worker (AudioBridge)
  // The service worker posts the port via navigator.serviceWorker.controller
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string } | undefined;
    if (data?.type === 'AUDIO_BRIDGE_PORT' && event.ports[0]) {
      audioBridgeSender.attachPort(event.ports[0]);
      log('info', 'pipeline', 'AudioBridge sender port attached');
    }
  });

  // Handle beforeunload — trigger cleanup
  window.addEventListener('beforeunload', () => {
    log('info', 'pipeline', 'Offscreen document unloading — cleaning up');
    void orchestrator.stopSession('offscreen-unload');
    audioBridgeSender.close();
  });
}

// ── Session Lifecycle ───────────────────────────────────────

async function handleSessionStart(
  payload: { sourceLanguage: string; targetLanguage: string },
): Promise<void> {
  log('info', 'pipeline', 'Starting session via orchestrator', payload);
  console.log('[VB:offscreen] Starting session', payload);

  voiceTimeAccumulator = 0;
  voiceTimeStart = 0;
  isSpeaking = false;

  try {
    await orchestrator.startSession(payload);
    log('info', 'pipeline', 'Session started successfully');
    console.log('[VB:offscreen] Session started successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'pipeline', `Session start failed: ${message}`);
    sendMessage('ERROR', {
      code: 'session-start-failed',
      message,
      userMessage: `Failed to start translation: ${message}`,
    });
  }
}

async function handleSessionStop(payload: { reason: string }): Promise<void> {
  log('info', 'pipeline', 'Stopping session via orchestrator', payload);
  console.log('[VB:offscreen] Stopping session', payload);

  if (isSpeaking) {
    voiceTimeAccumulator += Date.now() - voiceTimeStart;
    isSpeaking = false;
  }

  await orchestrator.stopSession(payload.reason);
  audioBridgeSender.close();
}

// ── Voice Time Tracking (Demo Quota) ────────────────────────

function trackVoiceTime(vadState: string): void {
  if (vadState === 'speech' && !isSpeaking) {
    isSpeaking = true;
    voiceTimeStart = Date.now();
  } else if (vadState === 'silence' && isSpeaking) {
    isSpeaking = false;
    voiceTimeAccumulator += Date.now() - voiceTimeStart;

    sendMessage('DEMO_TIME_UPDATE', {
      voiceTimeUsedMs: voiceTimeAccumulator,
      voiceTimeRemainingMs: DEMO_UNLIMITED
        ? Infinity
        : Math.max(0, DEMO_VOICE_LIMIT_MS - voiceTimeAccumulator),
    });

    if (!DEMO_UNLIMITED && voiceTimeAccumulator >= DEMO_VOICE_LIMIT_MS) {
      sendMessage('DEMO_LIMIT_REACHED', { resetsAt: Date.now() + 86400000 });
      void handleSessionStop({ reason: 'demo-limit' });
    }
  }
}

// ── Boot ────────────────────────────────────────────────────

init();
