/**
 * Core type definitions for VoiceBridge.
 * Shared across all extension contexts.
 */

// ── Pipeline Types ──────────────────────────────────────────

export type PipelineStage =
  | 'CAPTURED'
  | 'TRANSCRIBED'
  | 'TRANSLATED'
  | 'SYNTHESIZED'
  | 'PLAYED'
  | 'DROPPED';

export interface PipelineUtterance {
  sequenceId: number;
  state: PipelineStage;
  capturedAt: number;
  transcript?: string;
  detectedLanguage?: string;
  translation?: string;
  audioChunks: ArrayBuffer[];
  droppedReason?: string;
  latency?: LatencyMeasurement;
}

// ── Session Types ───────────────────────────────────────────

export interface SessionState {
  active: boolean;
  startedAt: number;
  sourceLanguage: string;
  targetLanguage: string;
  totalUtterances: number;
  droppedUtterances: number;
  currentSequenceId: number;
  voiceTimeMs: number;
  ttsCharactersUsed: number;
  sttSecondsUsed: number;
  llmTokensUsed: number;
}

// ── Connection Types ────────────────────────────────────────

export type ServiceConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected' }
  | { status: 'error'; error: string; retryable: boolean };

export interface PipelineHealth {
  stt: ServiceConnectionState;
  tts: ServiceConnectionState;
  llm: ServiceConnectionState;
  overallStatus: 'healthy' | 'degraded' | 'offline';
}

// ── Transcript Types ────────────────────────────────────────

export interface TranscriptEntry {
  sequenceId: number;
  timestamp: number;
  originalText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  isFinal: boolean;
  latencyMs: number;
}

// ── Latency Types ───────────────────────────────────────────

export interface LatencyMeasurement {
  sequenceId: number;
  captureMs: number;
  sttMs: number;
  translationMs: number;
  ttsMs: number;
  routingMs: number;
  totalMs: number;
  timestamp: number;
}

// ── Quota Types ─────────────────────────────────────────────

export interface QuotaState {
  elevenLabsCharactersUsed: number;
  elevenLabsCharactersLimit: number;
  percentUsed: number;
  warningLevel: 'none' | 'warning' | 'urgent' | 'exhausted';
}

// ── Demo Types ──────────────────────────────────────────────

export type DemoModeState =
  | { mode: 'demo'; voiceTimeRemainingMs: number; windowResetsAt: number }
  | { mode: 'unlimited'; apiKeySource: 'byo' }
  | { mode: 'disabled'; reason: 'embedded-key-exhausted' | 'limit-reached'; resetsAt?: number };

export interface DemoUsageState {
  voiceTimeUsedMs: number;
  windowStartTimestamp: number;
  installId: string;
}

export interface DailyUsage {
  date: string;
  ttsCharacters: number;
  sttSeconds: number;
  llmTokens: number;
  estimatedCostUsd: number;
}

// ── Language Types ───────────────────────────────────────────

export interface LanguageInfo {
  code: string;
  name: string;
  nativeName: string;
  sttSupported: boolean;
  ttsSupported: boolean;
  tier: 'full' | 'text-only';
}

// ── Meeting Types ───────────────────────────────────────────

export type MeetingPlatform = 'google-meet' | 'zoom' | 'teams' | 'discord' | 'generic' | 'none';

export type AudioInjectionStrategy =
  | { type: 'getUserMedia-intercept' }
  | { type: 'tabCapture-mix' }
  | { type: 'replaceTrack' }
  | { type: 'none' };

// ── Voice Profile Types ─────────────────────────────────────

export type VoiceProfileState =
  | { status: 'not-set-up' }
  | { status: 'recording'; durationMs: number }
  | { status: 'uploading'; progress: number }
  | { status: 'processing' }
  | { status: 'ready'; voiceId: string; createdAt: number }
  | { status: 'error'; error: string };

export type VoiceSampleError =
  | { code: 'too-short'; minDurationMs: 30000 }
  | { code: 'too-long'; maxDurationMs: 120000 }
  | { code: 'too-noisy'; averageRmsDb: number; thresholdDb: -30 };

// ── Widget Types ────────────────────────────────────────────

export type WidgetDisplayState =
  | { mode: 'collapsed'; icon: WidgetIcon }
  | { mode: 'expanded'; latencyMs: number; languagePair: string; sessionDuration: string; statusColor: string }
  | { mode: 'error'; message: string }
  | { mode: 'roulette'; currentLanguage: string; progress: number }
  | { mode: 'ghost'; sensitivityLevel: number };

export type WidgetIcon = 'microphone' | 'globe' | 'speaker' | 'pause' | 'ghost' | 'offline';

// ── Echo Cancellation Types ─────────────────────────────────

export type EchoState =
  | { status: 'listening' }
  | { status: 'speaking'; ttsStartedAt: number }
  | { status: 'transitioning'; ttsEndedAt: number };

export type EchoEvent =
  | { type: 'tts_start' }
  | { type: 'tts_end' }
  | { type: 'transition_complete' }
  | { type: 'barge_in' };

// ── VAD Types ───────────────────────────────────────────────

export type VADState =
  | { status: 'silence' }
  | { status: 'speech-pending'; startedAt: number }
  | { status: 'speech' }
  | { status: 'silence-pending'; startedAt: number };

// ── Settings Types ──────────────────────────────────────────

export type LLMProvider = 'openai' | 'anthropic';

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface VoiceSettings {
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
}

// ── Roulette Types ──────────────────────────────────────────

export type RouletteState =
  | { status: 'idle' }
  | { status: 'capturing' }
  | { status: 'playing'; currentIndex: number; totalLanguages: number; currentLanguage: string }
  | { status: 'complete' };

// ── Debug Types ─────────────────────────────────────────────

export interface DebugLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  category: 'connection' | 'audio' | 'pipeline' | 'api' | 'state' | 'quota';
  message: string;
  metadata?: Record<string, unknown>;
}

// ── Error Types ─────────────────────────────────────────────

export type ErrorSeverity = 'recoverable' | 'degraded' | 'fatal';

export type DomainError =
  | { domain: 'stt'; code: 'connection-failed' | 'token-expired' | 'quota-exceeded' | 'rate-limited' }
  | { domain: 'tts'; code: 'connection-failed' | 'voice-not-found' | 'quota-exceeded' | 'rate-limited' }
  | { domain: 'llm'; code: 'connection-failed' | 'rate-limited' | 'timeout' | 'invalid-response' }
  | { domain: 'audio'; code: 'mic-denied' | 'mic-disconnected' | 'worklet-error' | 'context-failed' }
  | { domain: 'meeting'; code: 'no-platform' | 'injection-failed' | 'track-replace-failed' }
  | { domain: 'auth'; code: 'invalid-key' | 'key-decrypt-failed' }
  | { domain: 'quota'; code: 'demo-limit' | 'embedded-key-exhausted' | 'elevenlabs-exhausted' };

// ── Result Type ─────────────────────────────────────────────

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };
