/**
 * Inter-context message bus for VoiceBridge.
 * All messages are typed, timestamped, and sender-validated.
 */

import type {
  SessionState, ServiceConnectionState, EchoState, VADState,
  LatencyMeasurement, MeetingPlatform, VoiceProfileState, DebugLogEntry,
  AudioRoutingState, DegradationLevel, PipelineStage, LLMProvider,
} from './types.js';

// ── Message Types ───────────────────────────────────────────

export type MessageType =
  | 'SESSION_START' | 'SESSION_STOP' | 'SESSION_STATE_CHANGED'
  | 'STT_TRANSCRIPT_PARTIAL' | 'STT_TRANSCRIPT_FINAL' | 'STT_COMMIT'
  | 'TRANSLATION_PARTIAL' | 'TRANSLATION_FINAL'
  | 'TTS_AUDIO_CHUNK' | 'TTS_PLAYBACK_START' | 'TTS_PLAYBACK_END'
  | 'ECHO_STATE_CHANGED' | 'BARGE_IN_DETECTED'
  | 'AUDIO_CAPTURE_START' | 'AUDIO_CAPTURE_STOP' | 'AUDIO_LEVEL'
  | 'CONNECTION_STATE_CHANGED' | 'LATENCY_UPDATE'
  | 'MEETING_DETECTED' | 'MEETING_LOST'
  | 'WIDGET_TOGGLE' | 'WIDGET_POSITION_SAVE'
  | 'LANGUAGE_CHANGED' | 'SETTINGS_UPDATED'
  | 'QUOTA_WARNING' | 'QUOTA_EXHAUSTED'
  | 'DEMO_TIME_UPDATE' | 'DEMO_LIMIT_REACHED' | 'DEMO_RESET'
  | 'VOICE_PROFILE_STATUS' | 'VOICE_PROFILE_PREVIEW'
  | 'ROULETTE_START' | 'ROULETTE_LANGUAGE_CHANGE' | 'ROULETTE_COMPLETE'
  | 'GHOST_MODE_TOGGLE' | 'GHOST_SENSITIVITY_UPDATE'
  | 'ERROR' | 'DEBUG_LOG'
  | 'AUDIO_ROUTING_STATE_CHANGED' | 'DEGRADATION_LEVEL_CHANGED' | 'UTTERANCE_STATE_CHANGED'
  | 'TRACK_INJECT' | 'TRACK_RESTORE' | 'TRACK_STATUS'
  | 'AUDIO_BRIDGE_READY' | 'AUDIO_BRIDGE_DISCONNECTED'
  | 'DEMO_KEYS_POPULATED' | 'EMBEDDED_KEY_EXHAUSTED' | 'CLEANUP_COMPLETE';

export type ExtensionContext = 'service-worker' | 'offscreen' | 'content-script' | 'popup' | 'sidepanel';

export interface MessagePayloadMap {
  SESSION_START: { sourceLanguage: string; targetLanguage: string };
  SESSION_STOP: { reason: 'user' | 'error' | 'quota' | 'demo-limit' | 'tab-closed' };
  SESSION_STATE_CHANGED: SessionState;

  STT_TRANSCRIPT_PARTIAL: { text: string; language: string; sequenceId: number };
  STT_TRANSCRIPT_FINAL: { text: string; language: string; sequenceId: number };
  STT_COMMIT: { sequenceId: number };

  TRANSLATION_PARTIAL: { text: string; sequenceId: number };
  TRANSLATION_FINAL: { text: string; sequenceId: number };

  TTS_AUDIO_CHUNK: { buffer: ArrayBuffer; sequenceId: number };
  TTS_PLAYBACK_START: { sequenceId: number };
  TTS_PLAYBACK_END: { sequenceId: number };

  ECHO_STATE_CHANGED: { state: EchoState };
  BARGE_IN_DETECTED: { sequenceId: number };

  AUDIO_CAPTURE_START: undefined;
  AUDIO_CAPTURE_STOP: undefined;
  AUDIO_LEVEL: { rmsDb: number; vadState: VADState['status'] };

  CONNECTION_STATE_CHANGED: { service: 'stt' | 'tts' | 'llm'; state: ServiceConnectionState };
  LATENCY_UPDATE: LatencyMeasurement;

  MEETING_DETECTED: { platform: MeetingPlatform; tabId: number };
  MEETING_LOST: { tabId: number };

  WIDGET_TOGGLE: undefined;
  WIDGET_POSITION_SAVE: { domain: string; x: number; y: number };

  LANGUAGE_CHANGED: { sourceLanguage: string; targetLanguage: string };
  SETTINGS_UPDATED: Record<string, unknown>;

  QUOTA_WARNING: { level: 'warning' | 'urgent'; percentUsed: number };
  QUOTA_EXHAUSTED: undefined;

  DEMO_TIME_UPDATE: { voiceTimeRemainingMs: number; voiceTimeUsedMs: number };
  DEMO_LIMIT_REACHED: { resetsAt: number };
  DEMO_RESET: { voiceTimeAvailableMs: number };

  VOICE_PROFILE_STATUS: VoiceProfileState;
  VOICE_PROFILE_PREVIEW: { audioBuffer: ArrayBuffer };

  ROULETTE_START: { sentence: string; languages: string[] };
  ROULETTE_LANGUAGE_CHANGE: { language: string; index: number; total: number };
  ROULETTE_COMPLETE: undefined;

  GHOST_MODE_TOGGLE: { enabled: boolean };
  GHOST_SENSITIVITY_UPDATE: { level: number };

  ERROR: { code: string; message: string; userMessage: string; action?: string };
  DEBUG_LOG: DebugLogEntry;

  AUDIO_ROUTING_STATE_CHANGED: { state: AudioRoutingState };
  DEGRADATION_LEVEL_CHANGED: { level: DegradationLevel; previous: DegradationLevel; trigger: string };
  UTTERANCE_STATE_CHANGED: { sequenceId: number; state: PipelineStage; reason?: string };
  TRACK_INJECT: { tabId: number };
  TRACK_RESTORE: { tabId: number };
  TRACK_STATUS: { injected: boolean; platform: MeetingPlatform };
  AUDIO_BRIDGE_READY: { tabId: number };
  AUDIO_BRIDGE_DISCONNECTED: { tabId: number };
  DEMO_KEYS_POPULATED: { provider: LLMProvider };
  EMBEDDED_KEY_EXHAUSTED: undefined;
  CLEANUP_COMPLETE: { errors: Array<{ name: string; message: string }> };
}

export interface ExtensionMessage<T extends MessageType = MessageType> {
  type: T;
  payload: MessagePayloadMap[T];
  timestamp: number;
  sequenceId?: number;
  source: ExtensionContext;
}

// ── Message Bus ─────────────────────────────────────────────

type MessageHandler<T extends MessageType> = (
  payload: MessagePayloadMap[T],
  message: ExtensionMessage<T>
) => void | Promise<void>;

/** Detect which extension context we're running in */
function detectContext(): ExtensionContext {
  if (typeof self !== 'undefined' && 'ServiceWorkerGlobalScope' in self) {
    return 'service-worker';
  }
  if (typeof document !== 'undefined' && document.URL.includes('offscreen.html')) {
    return 'offscreen';
  }
  if (typeof document !== 'undefined' && document.URL.includes('popup.html')) {
    return 'popup';
  }
  if (typeof document !== 'undefined' && document.URL.includes('sidepanel.html')) {
    return 'sidepanel';
  }
  return 'content-script';
}

const handlers = new Map<MessageType, Set<MessageHandler<MessageType>>>();
let currentContext: ExtensionContext | undefined;

/**
 * Send a typed message to other extension contexts.
 * Routes through chrome.runtime.sendMessage.
 */
export function sendMessage<T extends MessageType>(
  type: T,
  payload: MessagePayloadMap[T],
  tabId?: number
): void {
  if (!currentContext) currentContext = detectContext();

  const message: ExtensionMessage<T> = {
    type,
    payload,
    timestamp: Date.now(),
    source: currentContext,
  };

  if (tabId !== undefined) {
    chrome.tabs.sendMessage(tabId, message);
  } else {
    chrome.runtime.sendMessage(message);
  }
}

/**
 * Register a handler for a specific message type.
 * Validates sender.id matches extension ID.
 */
export function onMessage<T extends MessageType>(
  type: T,
  handler: MessageHandler<T>
): () => void {
  if (!handlers.has(type)) {
    handlers.set(type, new Set());
  }
  const set = handlers.get(type)!;
  set.add(handler as MessageHandler<MessageType>);

  return () => { set.delete(handler as MessageHandler<MessageType>); };
}

/** Initialize the message bus listener. Call once per context. */
export function initMessageBus(): void {
  currentContext = detectContext();

  // SECURITY: Validate sender on every message
  chrome.runtime.onMessage.addListener(
    (raw: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id) return;

      const message = raw as ExtensionMessage;
      if (!message.type || !message.timestamp) return;

      const set = handlers.get(message.type);
      if (!set) return;

      for (const handler of set) {
        handler(message.payload, message);
      }
    }
  );
}

// ── Content Script ↔ Page Bridge ────────────────────────────

const PAGE_SOURCE = 'voicebridge';

export interface PageMessage {
  source: typeof PAGE_SOURCE;
  type: string;
  payload: unknown;
}

/**
 * Send a message from content script to the page's main world.
 */
export function postToPage(type: string, payload: unknown): void {
  window.postMessage({ source: PAGE_SOURCE, type, payload } satisfies PageMessage, window.location.origin);
}

/**
 * Listen for messages from the page's main world in the content script.
 */
export function onPageMessage(type: string, handler: (payload: unknown) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as PageMessage | undefined;
    if (data?.source !== PAGE_SOURCE) return;
    if (data.type !== type) return;
    handler(data.payload);
  };

  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
