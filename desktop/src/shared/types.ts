/**
 * Shared type definitions for VoiceBridge Desktop.
 * Reuses pipeline types from the Chrome extension codebase,
 * adds desktop-specific types for native audio, IPC, and settings.
 */

// ── Re-export pipeline types from existing codebase ─────────
// These are copied here to decouple from the Chrome extension.
// The original types live in src/lib/types.ts.

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

export type ServiceConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected' }
  | { status: 'error'; error: string; retryable: boolean };

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

export type EchoState =
  | { status: 'listening' }
  | { status: 'speaking'; ttsStartedAt: number }
  | { status: 'transitioning'; ttsEndedAt: number };

export type EchoEvent =
  | { type: 'tts_start' }
  | { type: 'tts_end' }
  | { type: 'transition_complete' }
  | { type: 'barge_in' };

export type VADState =
  | { status: 'silence' }
  | { status: 'speech-pending'; startedAt: number }
  | { status: 'speech' }
  | { status: 'silence-pending'; startedAt: number };

export type AudioRoutingState = 'PASSTHROUGH' | 'MUTED' | 'TTS_PLAYING' | 'BARGE_IN';

export type AudioRoutingEvent =
  | { type: 'session_start' }
  | { type: 'session_stop' }
  | { type: 'vad_speech_start' }
  | { type: 'vad_speech_end' }
  | { type: 'tts_start' }
  | { type: 'tts_end' }
  | { type: 'barge_in' }
  | { type: 'degraded_to_passthrough' };

export type DegradationLevel = 'full' | 'text-only' | 'transcription-only' | 'passthrough';

export interface DegradationTransition {
  from: DegradationLevel;
  to: DegradationLevel;
  trigger: string;
  timestamp: number;
}

export type LLMProvider = 'openai' | 'anthropic' | 'openrouter';

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

export type VoiceProfileState =
  | { status: 'not-set-up' }
  | { status: 'recording'; durationMs: number }
  | { status: 'uploading'; progress: number }
  | { status: 'processing' }
  | { status: 'ready'; voiceId: string; createdAt: number }
  | { status: 'error'; error: string };

export interface DebugLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  category: 'connection' | 'audio' | 'pipeline' | 'api' | 'state' | 'quota';
  message: string;
  metadata?: Record<string, unknown>;
}


export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface CleanupTarget {
  name: string;
  cleanup: () => Promise<void> | void;
}

export interface CleanupResult {
  success: boolean;
  errors: Array<{ name: string; error: Error }>;
  durationMs: number;
}

// ── Desktop-Specific Types ──────────────────────────────────

/** Audio device info from the native addon */
export interface AudioDeviceInfo {
  id: string;
  name: string;
  sampleRate: number;
  channels: number;
  isDefault: boolean;
}

/** Configuration for real mic capture */
export interface CaptureConfig {
  sampleRate: 16000;
  channels: 1;
  bufferSizeMs: 250;
  format: 'pcm_s16le';
}

/** Result of driver installation */
export interface DriverInstallResult {
  success: boolean;
  error?: string;
  osErrorCode?: number;
  requiresReboot?: boolean;
}

/** Virtual mic driver status */
export type DriverStatus =
  | { state: 'installed'; version: string; active: boolean; sampleRate: number }
  | { state: 'not-installed' }
  | { state: 'error'; error: string };

/** Audio data flowing through the pipeline */
export interface AudioChunk {
  pcm: Buffer;
  sampleRate: number;
  channels: 1;
  format: 'pcm_s16le' | 'pcm_f32le';
  sequenceId: number;
  timestamp: number;
}

/** Bundled with each platform build */
export interface DriverManifest {
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'x64' | 'arm64';
  driverBinaryPath: string;
  installScript: string;
  uninstallScript: string;
  checksum: string;
}

/** Validated IPC message envelope */
export interface IPCMessage<T extends string = string> {
  channel: T;
  payload: unknown;
  timestamp: number;
  nonce: string;
}

/** Language info */
export interface Language {
  code: string;
  name: string;
}

// ── IPC Channel Maps ────────────────────────────────────────

/** Main process → Renderer events (one-way push) */
export interface MainToRendererEvents {
  'pipeline:latency-update': LatencyMeasurement;
  'pipeline:stage-update': { sequenceId: number; stage: PipelineStage };
  'pipeline:partial-transcript': { text: string };
  'pipeline:degradation-changed': { level: DegradationLevel; previous: DegradationLevel };
  'session:state-changed': SessionState;
  'connection:state-changed': { service: 'stt' | 'tts' | 'llm'; state: ServiceConnectionState };
  'audio:level': { rmsDb: number; vadState: VADState['status'] };
  'audio:driver-status': DriverStatus;
  'error': { code: string; message: string; userMessage: string };
}

/** Renderer → Main process invocations (request/response) */
export interface RendererToMainInvocations {
  'session:start': [{ sourceLanguage: string; targetLanguage: string }, void];
  'session:stop': [{ reason: string }, void];
  'settings:get': [{ key: string }, unknown];
  'settings:set': [{ key: string; value: unknown }, void];
  'settings:export': [void, string];
  'settings:import': [string, void];
  'devices:list': [void, AudioDeviceInfo[]];
  'devices:select': [{ deviceId: string }, void];
  'driver:status': [void, DriverStatus];
  'driver:install': [void, DriverInstallResult];
  'driver:uninstall': [void, boolean];
  'voice:start-recording': [void, void];
  'voice:stop-recording': [void, Blob];
  'voice:upload': [void, string];
  'voice:delete': [{ voiceId: string }, void];
  'voice:preview': [{ voiceId: string; text: string; language: string }, ArrayBuffer];
  'languages:list': [void, Language[]];
  'debug:get-log': [void, DebugLogEntry[]];
}


// ── Desktop Settings Schema ─────────────────────────────────

export interface DesktopSettingsSchema {
  // Encrypted (AES-GCM-256)
  elevenLabsApiKey: string;
  llmApiKey: string;

  // Plaintext JSON
  sourceLanguage: string;
  targetLanguage: string;
  recentLanguages: string[];
  llmProvider: LLMProvider;
  openRouterModel: string;
  contextWindowSize: number;
  preserveTechnicalTerms: boolean;
  customGlossary: GlossaryEntry[];
  meetingContext: string;
  formalityLevel: 'formal' | 'informal';
  voiceProfileId: string;
  voiceStability: number;
  voiceSimilarityBoost: number;
  voiceStyle: number;
  selectedMicDeviceId: string | null;
  noiseGateThresholdDb: number;
  vadSensitivity: 'low' | 'medium' | 'high';
  ghostMode: boolean;
  pushToTalk: boolean;
  autoStartEnabled: boolean;
  theme: 'dark' | 'light' | 'system';
  keyboardShortcuts: {
    toggleTranslation: string;
    ghostMode: string;
    panicStop: string;
  };
  installId: string;
  onboardingComplete: boolean;
  settingsSchemaVersion: number;
  driverVersion: string | null;
  languageCache: { stt: string[]; tts: string[]; cachedAt: number };
}

/** Keys that are encrypted at rest */
export const ENCRYPTED_SETTINGS_KEYS: ReadonlySet<keyof DesktopSettingsSchema> = new Set([
  'elevenLabsApiKey',
  'llmApiKey',
]);

/** Default settings values */
export const DEFAULT_SETTINGS: DesktopSettingsSchema = {
  elevenLabsApiKey: '',
  llmApiKey: '',
  sourceLanguage: 'auto',
  targetLanguage: 'es',
  recentLanguages: [],
  llmProvider: 'openai',
  openRouterModel: 'openai/gpt-4o',
  contextWindowSize: 10,
  preserveTechnicalTerms: true,
  customGlossary: [],
  meetingContext: '',
  formalityLevel: 'informal',
  voiceProfileId: '',
  voiceStability: 0.5,
  voiceSimilarityBoost: 0.8,
  voiceStyle: 0.35,
  selectedMicDeviceId: null,
  noiseGateThresholdDb: -40,
  vadSensitivity: 'high',
  ghostMode: false,
  pushToTalk: true,
  autoStartEnabled: false,
  theme: 'dark',
  keyboardShortcuts: {
    toggleTranslation: 'CmdOrCtrl+Shift+T',
    ghostMode: 'CmdOrCtrl+Shift+G',
    panicStop: 'CmdOrCtrl+Shift+X',
  },
  installId: '',
  onboardingComplete: false,
  settingsSchemaVersion: 1,
  driverVersion: null,
  languageCache: { stt: [], tts: [], cachedAt: 0 },
};

/** Known IPC channels for validation */
export const VALID_RENDERER_CHANNELS: ReadonlySet<string> = new Set([
  'session:start', 'session:stop',
  'settings:get', 'settings:set', 'settings:export', 'settings:import',
  'devices:list', 'devices:select',
  'driver:status', 'driver:install', 'driver:uninstall',
  'voice:start-recording', 'voice:stop-recording', 'voice:upload', 'voice:delete', 'voice:preview',
  'languages:list',
  'debug:get-log',
]);

export const VALID_MAIN_CHANNELS: ReadonlySet<string> = new Set([
  'pipeline:latency-update', 'pipeline:stage-update', 'pipeline:degradation-changed',
  'pipeline:partial-transcript',
  'session:state-changed',
  'connection:state-changed',
  'audio:level', 'audio:driver-status',
  'error',
]);