/**
 * VoiceBridge Desktop — Preact renderer entry point.
 * Nothing design system: OLED black, Space Grotesk + Space Mono,
 * three-layer visual hierarchy, mechanical toggles, no shadows.
 *
 * BYO keys: users enter their own API keys during onboarding
 * and can change them later in settings.
 */

import { render } from 'preact';
import { useState, useEffect, useReducer, useCallback } from 'preact/hooks';
import type { VoiceBridgeAPI } from '../preload/preload.js';

// ── Global Type Declaration ─────────────────────────────────

declare global {
  interface Window {
    voicebridge: VoiceBridgeAPI;
  }
}

const vb = window.voicebridge;

// ── Language Options (verified against ElevenLabs docs April 2026) ───

/**
 * STT languages — Scribe v2 Realtime supports 90+ languages.
 * Used for "I Speak" selector. Auto-detect is default.
 */
const STT_LANGUAGES = [
  { code: 'af', name: 'Afrikaans' }, { code: 'ar', name: 'Arabic' },
  { code: 'hy', name: 'Armenian' }, { code: 'as', name: 'Assamese' },
  { code: 'az', name: 'Azerbaijani' }, { code: 'be', name: 'Belarusian' },
  { code: 'bn', name: 'Bengali' }, { code: 'bs', name: 'Bosnian' },
  { code: 'bg', name: 'Bulgarian' }, { code: 'ca', name: 'Catalan' },
  { code: 'ceb', name: 'Cebuano' }, { code: 'zh', name: 'Chinese (Mandarin)' },
  { code: 'hr', name: 'Croatian' }, { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' }, { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' }, { code: 'et', name: 'Estonian' },
  { code: 'fil', name: 'Filipino' }, { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' }, { code: 'gl', name: 'Galician' },
  { code: 'ka', name: 'Georgian' }, { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' }, { code: 'gu', name: 'Gujarati' },
  { code: 'ha', name: 'Hausa' }, { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' }, { code: 'hu', name: 'Hungarian' },
  { code: 'is', name: 'Icelandic' }, { code: 'id', name: 'Indonesian' },
  { code: 'ga', name: 'Irish' }, { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' }, { code: 'jv', name: 'Javanese' },
  { code: 'kn', name: 'Kannada' }, { code: 'kk', name: 'Kazakh' },
  { code: 'ky', name: 'Kirghiz' }, { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' }, { code: 'ln', name: 'Lingala' },
  { code: 'lt', name: 'Lithuanian' }, { code: 'lb', name: 'Luxembourgish' },
  { code: 'mk', name: 'Macedonian' }, { code: 'ms', name: 'Malay' },
  { code: 'ml', name: 'Malayalam' }, { code: 'mr', name: 'Marathi' },
  { code: 'ne', name: 'Nepali' }, { code: 'no', name: 'Norwegian' },
  { code: 'ps', name: 'Pashto' }, { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' }, { code: 'pt', name: 'Portuguese' },
  { code: 'pa', name: 'Punjabi' }, { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' }, { code: 'sr', name: 'Serbian' },
  { code: 'sd', name: 'Sindhi' }, { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' }, { code: 'so', name: 'Somali' },
  { code: 'es', name: 'Spanish' }, { code: 'sw', name: 'Swahili' },
  { code: 'sv', name: 'Swedish' }, { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' }, { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' }, { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' }, { code: 'vi', name: 'Vietnamese' },
  { code: 'cy', name: 'Welsh' },
];

/**
 * TTS languages — Eleven v3 supports 70+ languages for voice synthesis.
 * Used for "Translate To" selector. Only languages TTS can actually speak.
 * Source: https://elevenlabs.io/docs/developer-guides/models
 */
const TTS_LANGUAGES = [
  { code: 'af', name: 'Afrikaans' }, { code: 'ar', name: 'Arabic' },
  { code: 'hy', name: 'Armenian' }, { code: 'as', name: 'Assamese' },
  { code: 'az', name: 'Azerbaijani' }, { code: 'be', name: 'Belarusian' },
  { code: 'bn', name: 'Bengali' }, { code: 'bs', name: 'Bosnian' },
  { code: 'bg', name: 'Bulgarian' }, { code: 'ca', name: 'Catalan' },
  { code: 'ceb', name: 'Cebuano' }, { code: 'zh', name: 'Chinese (Mandarin)' },
  { code: 'hr', name: 'Croatian' }, { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' }, { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' }, { code: 'et', name: 'Estonian' },
  { code: 'fil', name: 'Filipino' }, { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' }, { code: 'gl', name: 'Galician' },
  { code: 'ka', name: 'Georgian' }, { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' }, { code: 'gu', name: 'Gujarati' },
  { code: 'ha', name: 'Hausa' }, { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' }, { code: 'hu', name: 'Hungarian' },
  { code: 'is', name: 'Icelandic' }, { code: 'id', name: 'Indonesian' },
  { code: 'ga', name: 'Irish' }, { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' }, { code: 'jv', name: 'Javanese' },
  { code: 'kn', name: 'Kannada' }, { code: 'kk', name: 'Kazakh' },
  { code: 'ky', name: 'Kirghiz' }, { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' }, { code: 'ln', name: 'Lingala' },
  { code: 'lt', name: 'Lithuanian' }, { code: 'lb', name: 'Luxembourgish' },
  { code: 'mk', name: 'Macedonian' }, { code: 'ms', name: 'Malay' },
  { code: 'ml', name: 'Malayalam' }, { code: 'mr', name: 'Marathi' },
  { code: 'ne', name: 'Nepali' }, { code: 'no', name: 'Norwegian' },
  { code: 'ps', name: 'Pashto' }, { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' }, { code: 'pt', name: 'Portuguese' },
  { code: 'pa', name: 'Punjabi' }, { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' }, { code: 'sr', name: 'Serbian' },
  { code: 'sd', name: 'Sindhi' }, { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' }, { code: 'so', name: 'Somali' },
  { code: 'es', name: 'Spanish' }, { code: 'sw', name: 'Swahili' },
  { code: 'sv', name: 'Swedish' }, { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' }, { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' }, { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' }, { code: 'vi', name: 'Vietnamese' },
  { code: 'cy', name: 'Welsh' },
];

// ── State ───────────────────────────────────────────────────

interface AppState {
  sessionActive: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  latencyMs: number;
  latencyColor: 'green' | 'yellow' | 'red';
  sttStatus: string;
  ttsStatus: string;
  llmStatus: string;
  degradationLevel: string;
  driverInstalled: boolean;
  hasApiKeys: boolean;
  onboardingComplete: boolean;
  loading: boolean;
  view: 'onboarding' | 'main' | 'settings';
}

type AppAction =
  | { type: 'SET_SESSION'; active: boolean }
  | { type: 'SET_LANGUAGES'; source: string; target: string }
  | { type: 'SET_LATENCY'; ms: number }
  | { type: 'SET_CONNECTION'; service: string; status: string }
  | { type: 'SET_DEGRADATION'; level: string }
  | { type: 'SET_DRIVER'; installed: boolean }
  | { type: 'SET_API_KEYS'; hasKeys: boolean }
  | { type: 'SET_ONBOARDING'; complete: boolean }
  | { type: 'SET_LOADED' }
  | { type: 'SET_VIEW'; view: 'onboarding' | 'main' | 'settings' };

const initialState: AppState = {
  sessionActive: false,
  sourceLanguage: 'auto',
  targetLanguage: 'es',
  latencyMs: 0,
  latencyColor: 'green',
  sttStatus: 'disconnected',
  ttsStatus: 'disconnected',
  llmStatus: 'disconnected',
  degradationLevel: 'full',
  driverInstalled: false,
  hasApiKeys: false,
  onboardingComplete: false,
  loading: true,
  view: 'main',
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SESSION':
      return { ...state, sessionActive: action.active };
    case 'SET_LANGUAGES':
      return { ...state, sourceLanguage: action.source, targetLanguage: action.target };
    case 'SET_LATENCY': {
      const color = action.ms < 1500 ? 'green' as const : action.ms <= 2500 ? 'yellow' as const : 'red' as const;
      return { ...state, latencyMs: action.ms, latencyColor: color };
    }
    case 'SET_CONNECTION':
      if (action.service === 'stt') return { ...state, sttStatus: action.status };
      if (action.service === 'tts') return { ...state, ttsStatus: action.status };
      if (action.service === 'llm') return { ...state, llmStatus: action.status };
      return state;
    case 'SET_DEGRADATION':
      return { ...state, degradationLevel: action.level };
    case 'SET_DRIVER':
      return { ...state, driverInstalled: action.installed };
    case 'SET_API_KEYS':
      return { ...state, hasApiKeys: action.hasKeys };
    case 'SET_ONBOARDING':
      return { ...state, onboardingComplete: action.complete, view: action.complete ? 'main' : 'onboarding' };
    case 'SET_LOADED':
      return { ...state, loading: false };
    case 'SET_VIEW':
      return { ...state, view: action.view };
  }
}

// ── Components ──────────────────────────────────────────────

function SessionToggle({ active, onToggle, disabled }: { active: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <button
      class="toggle-track"
      data-active={active ? 'true' : 'false'}
      onClick={disabled ? undefined : onToggle}
      aria-label={active ? 'Stop translation' : 'Start translation'}
      role="switch"
      aria-checked={active}
      style={{
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: 48, height: 28, minWidth: 48, minHeight: 28, flexShrink: 0,
        padding: 0, border: 'none',
      }}
    >
      <div class="toggle-thumb" />
    </button>
  );
}

function LatencyDisplay({ ms, color }: { ms: number; color: string }) {
  const colorClass = color === 'green' ? 'status-green' : color === 'yellow' ? 'status-yellow' : 'status-red';
  return (
    <div style={{ textAlign: 'center', padding: 'var(--space-md) 0' }}>
      <div class="label" style={{ marginBottom: 'var(--space-xs)' }}>LATENCY</div>
      <div class={`mono ${colorClass}`} style={{
        fontSize: 'var(--display-lg)',
        lineHeight: 'var(--lh-display-lg)',
        letterSpacing: 'var(--ls-display-lg)',
        fontWeight: 700,
      }}>
        {ms > 0 ? `${ms}` : '—'}
      </div>
      <div class="label" style={{ marginTop: 'var(--space-2xs)' }}>MS</div>
    </div>
  );
}

function ConnectionStatus({ stt, tts, llm }: { stt: string; tts: string; llm: string }) {
  const dot = (status: string) => status === 'connected' ? '●' : status === 'connecting' ? '◐' : '○';
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-lg)', padding: 'var(--space-sm) 0' }}>
      <span class="label">{dot(stt)} STT</span>
      <span class="label">{dot(tts)} TTS</span>
      <span class="label">{dot(llm)} LLM</span>
    </div>
  );
}

function DegradationLabel({ level }: { level: string }) {
  if (level === 'full') return null;
  const labels: Record<string, string> = {
    'text-only': '[TEXT ONLY]',
    'transcription-only': '[TRANSCRIPT ONLY]',
    'passthrough': '[PASSTHROUGH]',
  };
  const isPassthrough = level === 'passthrough';
  return (
    <div class="mono" style={{
      textAlign: 'center',
      fontSize: 'var(--caption)',
      color: isPassthrough ? 'var(--accent)' : 'var(--warning)',
      padding: 'var(--space-xs) 0',
    }}>
      {labels[level] ?? ''}
    </div>
  );
}

// ── Onboarding View ─────────────────────────────────────────

function OnboardingView({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<'keys' | 'voice' | 'done'>('keys');

  // ── Step 1: API Keys ────────────────────────────────────
  const [elevenLabsKey, setElevenLabsKey] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [llmProvider, setLlmProvider] = useState('openrouter');
  const [llmModel, setLlmModel] = useState('openai/gpt-4o');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Step 2: Voice Recording ─────────────────────────────
  const [recording, setRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recordedChunks, setRecordedChunks] = useState<Blob[]>([]);
  const [uploading, setUploading] = useState(false);
  const [voiceId, setVoiceId] = useState('');
  const [recordingTimer, setRecordingTimer] = useState<ReturnType<typeof setInterval> | null>(null);

  const handleSaveKeys = useCallback(async () => {
    if (!elevenLabsKey.trim()) { setError('ElevenLabs API key is required'); return; }
    if (!llmKey.trim()) { setError('LLM API key is required'); return; }

    setSaving(true);
    setError('');
    try {
      await vb.setSetting('elevenLabsApiKey', elevenLabsKey.trim());
      await vb.setSetting('llmApiKey', llmKey.trim());
      await vb.setSetting('llmProvider', llmProvider);
      await vb.setSetting('openRouterModel', llmModel);
      setStep('voice');
    } catch {
      setError('Failed to save keys. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [elevenLabsKey, llmKey, llmProvider]);

  const handleStartRecording = useCallback(async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false },
      });
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(1000);

      setMediaRecorder(recorder);
      setRecordedChunks(chunks);
      setRecording(true);
      setRecordingDuration(0);

      const start = Date.now();
      const timer = setInterval(() => {
        setRecordingDuration(Date.now() - start);
      }, 200);
      setRecordingTimer(timer);

      // Auto-stop at 2 minutes
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 120000);
    } catch {
      setError('Microphone access denied. Please allow microphone access.');
    }
  }, []);

  const handleStopRecording = useCallback(() => {
    if (recordingTimer) clearInterval(recordingTimer);
    setRecordingTimer(null);
    setRecording(false);

    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      // Stop all tracks
      for (const track of mediaRecorder.stream.getTracks()) track.stop();
    }
  }, [mediaRecorder, recordingTimer]);

  const handleUploadVoice = useCallback(async () => {
    if (recordedChunks.length === 0) { setError('No recording found. Please record again.'); return; }

    setUploading(true);
    setError('');
    try {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      // Convert blob to base64 for IPC transfer (chunked to avoid stack overflow)
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const base64 = btoa(binary);

      await vb.stopRecording(base64);
      const id = await vb.uploadVoice();
      setVoiceId(id);
      setStep('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setError(msg);
    } finally {
      setUploading(false);
    }
  }, [recordedChunks]);

  const handleFinish = useCallback(async () => {
    await vb.setSetting('onboardingComplete', true);
    onComplete();
  }, [onComplete]);

  const handleSkipVoice = useCallback(async () => {
    await vb.setSetting('onboardingComplete', true);
    onComplete();
  }, [onComplete]);

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, '0')}`;
  };

  // ── Step 1: API Keys ────────────────────────────────────
  if (step === 'keys') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 'var(--space-lg)', gap: 'var(--space-md)', overflow: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--heading)', color: 'var(--text-display)', letterSpacing: 'var(--ls-heading)' }}>
          VOICEBRIDGE
        </div>
        <div class="label">STEP 1 OF 2 — API KEYS</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--body-sm)', lineHeight: 1.5 }}>
          Your keys are encrypted (AES-256) and stored only on this device. VoiceBridge has no server — we never see, collect, or store your keys. They are sent only to the API providers you choose (ElevenLabs, OpenAI, etc.) when you use the app.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <div>
            <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>ELEVENLABS API KEY</label>
            <input class="input-field" type="password" placeholder="sk-..." value={elevenLabsKey}
              onInput={(e) => setElevenLabsKey((e.target as HTMLInputElement).value)} autocomplete="off" />
          </div>
          <div>
            <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>LLM PROVIDER</label>
            <select class="input-field" value={llmProvider} onChange={(e) => setLlmProvider((e.target as HTMLSelectElement).value)}>
              <option value="openrouter">OpenRouter</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div>
            <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>LLM API KEY</label>
            <input class="input-field" type="password" placeholder="sk-..." value={llmKey}
              onInput={(e) => setLlmKey((e.target as HTMLInputElement).value)} autocomplete="off" />
          </div>
          <div>
            <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>MODEL</label>
            <input class="input-field" type="text" placeholder="openai/gpt-4o" value={llmModel}
              onInput={(e) => setLlmModel((e.target as HTMLInputElement).value)} />
            <div class="mono" style={{ fontSize: '10px', color: 'var(--text-disabled)', marginTop: 'var(--space-2xs)' }}>
              {llmProvider === 'openrouter' ? 'e.g. openai/gpt-4o — browse openrouter.ai/models' : llmProvider === 'openai' ? 'e.g. gpt-4o, gpt-4o-mini' : 'e.g. claude-sonnet-4-20250514'}
            </div>
          </div>
        </div>
        {error && <div class="mono" style={{ color: 'var(--accent)', fontSize: 'var(--caption)' }}>{error}</div>}
        <div style={{ marginTop: 'auto' }}>
          <button class="btn-primary" onClick={handleSaveKeys} disabled={saving} style={{ width: '100%' }}>
            {saving ? 'SAVING...' : 'NEXT — VOICE CLONE'}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: Voice Recording ─────────────────────────────
  if (step === 'voice') {
    const hasRecording = recordedChunks.length > 0 && !recording;
    const tooShort = recordingDuration < 10000 && !recording && recordedChunks.length > 0;

    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 'var(--space-lg)', gap: 'var(--space-md)', overflow: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--heading)', color: 'var(--text-display)', letterSpacing: 'var(--ls-heading)' }}>
          VOICEBRIDGE
        </div>
        <div class="label">STEP 2 OF 2 — VOICE CLONE</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--body-sm)' }}>
          Record your voice to clone it. Read the text below naturally — at least 30 seconds for a good clone.
        </div>
        <div class="mono" style={{ fontSize: '10px', color: 'var(--text-disabled)' }}>
          Requires ElevenLabs Creator plan or higher. Free tier? Click "Skip" to use a default voice.
        </div>

        {/* Reading prompt */}
        <div style={{
          fontSize: 'var(--body-sm)', color: 'var(--text-primary)', lineHeight: 1.6,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: 'var(--space-md)',
        }}>
          "The quick brown fox jumps over the lazy dog. Technology has transformed the way we communicate across borders and languages. In today's interconnected world, the ability to speak and understand multiple languages opens doors to new opportunities and deeper connections with people from diverse backgrounds. Every conversation is a bridge between cultures, and every word carries the weight of understanding."
        </div>

        {/* Recording visualizer */}
        <div style={{ textAlign: 'center', padding: 'var(--space-lg) 0' }}>
          <div class="mono" style={{
            fontSize: 'var(--display-lg)',
            color: recording ? 'var(--accent)' : 'var(--text-display)',
            fontWeight: 700,
            transition: 'color var(--duration-fast) var(--ease-out)',
          }}>
            {formatDuration(recordingDuration)}
          </div>
          <div class="label" style={{ marginTop: 'var(--space-xs)' }}>
            {recording ? 'RECORDING...' : hasRecording ? 'RECORDED' : 'READY'}
          </div>
        </div>

        {/* Segmented progress — 30s target */}
        <div class="progress-segmented" style={{ height: '12px' }}>
          {Array.from({ length: 30 }, (_, i) => (
            <div key={i} class="progress-segment"
              data-filled={recordingDuration >= (i + 1) * 1000 ? 'true' : 'false'}
              style={{ background: recordingDuration >= (i + 1) * 1000 ? (i < 10 ? 'var(--warning)' : 'var(--success)') : undefined }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span class="label">0S</span>
          <span class="label" style={{ color: recordingDuration >= 10000 ? 'var(--success)' : 'var(--text-disabled)' }}>10S MIN</span>
          <span class="label" style={{ color: recordingDuration >= 30000 ? 'var(--success)' : 'var(--text-disabled)' }}>30S GOOD</span>
        </div>

        {tooShort && (
          <div class="mono" style={{ color: 'var(--warning)', fontSize: 'var(--caption)', textAlign: 'center' }}>
            Recording too short. Aim for at least 10 seconds.
          </div>
        )}

        {error && <div class="mono" style={{ color: 'var(--accent)', fontSize: 'var(--caption)', textAlign: 'center' }}>{error}</div>}

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          {!recording && !hasRecording && (
            <button class="btn-primary" onClick={handleStartRecording} style={{ width: '100%' }}>
              START RECORDING
            </button>
          )}
          {recording && (
            <button class="btn-primary" onClick={handleStopRecording}
              style={{ width: '100%', background: 'var(--accent)', color: '#fff' }}>
              STOP RECORDING
            </button>
          )}
          {hasRecording && !tooShort && (
            <button class="btn-primary" onClick={handleUploadVoice} disabled={uploading} style={{ width: '100%' }}>
              {uploading ? 'UPLOADING TO ELEVENLABS...' : 'CLONE MY VOICE'}
            </button>
          )}
          {hasRecording && (
            <button class="btn-secondary" onClick={handleStartRecording} style={{ width: '100%' }}>
              RE-RECORD
            </button>
          )}
          <button class="btn-secondary" onClick={handleSkipVoice}
            style={{ width: '100%', fontSize: 'var(--caption)', opacity: 0.6 }}>
            SKIP — USE DEFAULT VOICE
          </button>
        </div>
      </div>
    );
  }

  // ── Step 3: Done ────────────────────────────────────────
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 'var(--space-lg)', gap: 'var(--space-lg)', justifyContent: 'center', alignItems: 'center' }}>
      <div class="mono status-green" style={{ fontSize: 'var(--display-md)' }}>✓</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--heading)', color: 'var(--text-display)', textAlign: 'center' }}>
        VOICE CLONED
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--body-sm)', textAlign: 'center' }}>
        Your voice profile is ready. VoiceBridge will speak in your voice when translating.
      </div>
      <div class="label" style={{ color: 'var(--text-disabled)' }}>
        VOICE ID: {voiceId.slice(0, 12)}...
      </div>
      <div style={{ marginTop: 'var(--space-xl)', width: '100%' }}>
        <button class="btn-primary" onClick={handleFinish} style={{ width: '100%' }}>
          START USING VOICEBRIDGE
        </button>
      </div>
    </div>
  );
}

// ── Equalizer Visualizer ─────────────────────────────────────

const EQ_BARS = 12;
const ORIGINAL_COLOR = '#5B9BF6'; // interactive blue — your voice
const TRANSLATED_COLOR = '#D71921'; // accent red — translated voice

/**
 * Animated equalizer bars. Cyan = original mic input, Red = translated TTS output.
 * Bars animate with random heights when active, flat when idle.
 */
function Equalizer({ active, mode }: { active: boolean; mode: 'original' | 'translated' | 'idle' }) {
  const [bars, setBars] = useState<number[]>(Array(EQ_BARS).fill(0));

  useEffect(() => {
    if (!active) { setBars(Array(EQ_BARS).fill(0)); return; }
    const timer = setInterval(() => {
      setBars(Array.from({ length: EQ_BARS }, () => 0.1 + Math.random() * 0.9));
    }, 120);
    return () => clearInterval(timer);
  }, [active]);

  const color = mode === 'original' ? ORIGINAL_COLOR : mode === 'translated' ? TRANSLATED_COLOR : 'var(--border-visible)';

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '3px', height: '48px', padding: 'var(--space-xs) 0' }}>
      {bars.map((h, i) => (
        <div key={i} style={{
          width: '4px',
          height: `${Math.max(4, h * 48)}px`,
          background: active ? color : 'var(--border)',
          borderRadius: '1px',
          transition: 'height 100ms ease-out, background 200ms ease-out',
        }} />
      ))}
    </div>
  );
}

function EqLegend({ mode }: { mode: 'original' | 'translated' | 'idle' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-lg)', padding: 'var(--space-2xs) 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2xs)' }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: ORIGINAL_COLOR, opacity: mode === 'original' ? 1 : 0.3 }} />
        <span class="label" style={{ color: mode === 'original' ? ORIGINAL_COLOR : 'var(--text-disabled)' }}>YOUR VOICE</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2xs)' }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: TRANSLATED_COLOR, opacity: mode === 'translated' ? 1 : 0.3 }} />
        <span class="label" style={{ color: mode === 'translated' ? TRANSLATED_COLOR : 'var(--text-disabled)' }}>TRANSLATED</span>
      </div>
    </div>
  );
}

// ── Settings View ───────────────────────────────────────────

// ── Settings View ───────────────────────────────────────────

function SettingsView({ onBack }: { onBack: () => void }) {
  const [elevenLabsKey, setElevenLabsKey] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [llmProvider, setLlmProvider] = useState('openrouter');
  const [llmModel, setLlmModel] = useState('openai/gpt-4o');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [elValid, setElValid] = useState<boolean | null>(null);
  const [elValidating, setElValidating] = useState(false);
  const [llmValid, setLlmValid] = useState<boolean | null>(null);
  const [llmValidating, setLlmValidating] = useState(false);
  const [voices, setVoices] = useState<Array<{ voiceId: string; name: string; createdAt: number }>>([]);
  const [activeVoiceId, setActiveVoiceId] = useState('');
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recordedChunks, setRecordedChunks] = useState<Blob[]>([]);
  const [uploading, setUploading] = useState(false);
  const [recordingTimer, setRecordingTimer] = useState<ReturnType<typeof setInterval> | null>(null);
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('es');

  const refreshVoices = useCallback(async () => {
    setLoadingVoices(true);
    try { const list = await vb.listVoices(); setVoices(list); const a = await vb.getActiveVoice() as string; setActiveVoiceId(a ?? ''); } catch {}
    setLoadingVoices(false);
  }, []);

  useEffect(() => { (async () => {
    const el = await vb.getSetting('elevenLabsApiKey') as string;
    const llm = await vb.getSetting('llmApiKey') as string;
    const prov = await vb.getSetting('llmProvider') as string;
    const model = await vb.getSetting('openRouterModel') as string;
    if (el) setElevenLabsKey(el); if (llm) setLlmKey(llm); if (prov) setLlmProvider(prov);
    if (model) setLlmModel(model);
    const sl = await vb.getSetting('sourceLanguage') as string;
    const tl = await vb.getSetting('targetLanguage') as string;
    if (sl) setSourceLang(sl);
    if (tl) setTargetLang(tl);
    await refreshVoices();
  })(); }, [refreshVoices]);

  const handleValidateAndSave = useCallback(async () => {
    if (!elevenLabsKey.trim()) { setError('ElevenLabs API key is required'); return; }
    if (!llmKey.trim()) { setError('LLM API key is required'); return; }
    setSaving(true); setError(''); setSaved(false); setElValid(null); setLlmValid(null);
    setElValidating(true);
    const elR = await vb.validateElevenLabsKey(elevenLabsKey.trim());
    setElValidating(false); setElValid(elR.valid);
    if (!elR.valid) { setError('ElevenLabs: ' + (elR.error ?? 'Invalid')); setSaving(false); return; }
    setLlmValidating(true);
    const llmR = await vb.validateLLMKey(llmProvider, llmKey.trim());
    setLlmValidating(false); setLlmValid(llmR.valid);
    if (!llmR.valid) { setError('LLM: ' + (llmR.error ?? 'Invalid')); setSaving(false); return; }
    try { await vb.setSetting('elevenLabsApiKey', elevenLabsKey.trim()); await vb.setSetting('llmApiKey', llmKey.trim()); await vb.setSetting('llmProvider', llmProvider); await vb.setSetting('openRouterModel', llmModel); setSaved(true); setTimeout(() => setSaved(false), 3000); await refreshVoices(); } catch { setError('Failed to save.'); }
    finally { setSaving(false); }
  }, [elevenLabsKey, llmKey, llmProvider, refreshVoices]);

  const handleSelectVoice = useCallback(async (vid: string) => { await vb.setActiveVoice(vid); setActiveVoiceId(vid); }, []);
  const handleDeleteVoice = useCallback(async (vid: string) => { try { await vb.deleteVoice(vid); await refreshVoices(); } catch { setError('Delete failed.'); } }, [refreshVoices]);

  const handleStartRecording = useCallback(async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.start(1000);
      setMediaRecorder(rec); setRecordedChunks(chunks); setRecording(true); setRecordingDuration(0);
      const t0 = Date.now();
      const tmr = setInterval(() => setRecordingDuration(Date.now() - t0), 200);
      setRecordingTimer(tmr);
      setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 120000);
    } catch { setError('Microphone access denied.'); }
  }, []);

  const handleStopRecording = useCallback(() => {
    if (recordingTimer) clearInterval(recordingTimer);
    setRecordingTimer(null); setRecording(false);
    if (mediaRecorder?.state === 'recording') { mediaRecorder.stop(); for (const t of mediaRecorder.stream.getTracks()) t.stop(); }
  }, [mediaRecorder, recordingTimer]);

  const handleUploadVoice = useCallback(async () => {
    if (recordedChunks.length === 0) { setError('No recording.'); return; }
    setUploading(true); setError('');
    try {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      const b64 = btoa(bin);
      await vb.stopRecording(b64); await vb.uploadVoice();
      setRecordedChunks([]); setRecordingDuration(0); await refreshVoices();
    } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed'); }
    finally { setUploading(false); }
  }, [recordedChunks, refreshVoices]);

  const vIcon = (v: boolean | null, ld: boolean) => {
    if (ld) return <span class="mono" style={{ color: 'var(--text-disabled)', fontSize: 'var(--caption)' }}>◐ CHECKING...</span>;
    if (v === true) return <span class="mono status-green" style={{ fontSize: 'var(--caption)' }}>● VALID</span>;
    if (v === false) return <span class="mono" style={{ color: 'var(--accent)', fontSize: 'var(--caption)' }}>✗ INVALID</span>;
    return null;
  };
  const fmtDur = (ms: number) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0'); };
  const hasRec = recordedChunks.length > 0 && !recording;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 'var(--space-lg)', gap: 'var(--space-md)', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--subheading)', color: 'var(--text-display)' }}>SETTINGS</div>
        <button class="btn-secondary" onClick={onBack} style={{ fontSize: 'var(--caption)', padding: '8px 16px', minHeight: 'auto' }}>BACK</button>
      </div>

      {/* API Keys */}
      <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div class="label">API KEYS</div>
        <div class="mono" style={{ fontSize: '10px', color: 'var(--text-disabled)', lineHeight: 1.5 }}>
          Encrypted (AES-256) and stored only on this device. VoiceBridge has no server — we never see, collect, or store your keys.
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-xs)' }}>
            <label class="label">ELEVENLABS API KEY</label>{vIcon(elValid, elValidating)}
          </div>
          <input class="input-field" type="password" value={elevenLabsKey} onInput={(e) => { setElevenLabsKey((e.target as HTMLInputElement).value); setElValid(null); }} autocomplete="off" />
        </div>
        <div>
          <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>LLM PROVIDER</label>
          <select class="input-field" value={llmProvider} onChange={(e) => { const p = (e.target as HTMLSelectElement).value; setLlmProvider(p); setLlmValid(null); }}>
            <option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-xs)' }}>
            <label class="label">LLM API KEY</label>{vIcon(llmValid, llmValidating)}
          </div>
          <input class="input-field" type="password" value={llmKey} onInput={(e) => { setLlmKey((e.target as HTMLInputElement).value); setLlmValid(null); }} autocomplete="off" />
        </div>
        <div>
          <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>MODEL</label>
          <select class="input-field" value={llmModel} onChange={(e) => setLlmModel((e.target as HTMLSelectElement).value)}>
            {llmProvider === 'openrouter' && <>
              <optgroup label="OpenAI">
                <option value="openai/gpt-5.4">GPT-5.4</option>
                <option value="openai/gpt-5.4-mini">GPT-5.4 Mini</option>
                <option value="openai/gpt-4o">GPT-4o</option>
                <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
                <option value="openai/o3-pro">o3 Pro</option>
                <option value="openai/o3-mini">o3 Mini</option>
              </optgroup>
              <optgroup label="Anthropic">
                <option value="anthropic/claude-opus-4.6">Claude Opus 4.6</option>
                <option value="anthropic/claude-sonnet-4">Claude Sonnet 4</option>
                <option value="anthropic/claude-3.5-haiku">Claude 3.5 Haiku</option>
              </optgroup>
              <optgroup label="Google">
                <option value="google/gemini-3.1-pro">Gemini 3.1 Pro</option>
                <option value="google/gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
              </optgroup>
              <optgroup label="DeepSeek">
                <option value="deepseek/deepseek-chat-v3-0324">DeepSeek V3</option>
                <option value="deepseek/deepseek-r1">DeepSeek R1</option>
              </optgroup>
              <optgroup label="Kimi (Moonshot)">
                <option value="moonshotai/kimi-k2">Kimi K2</option>
              </optgroup>
              <optgroup label="GLM (Zhipu)">
                <option value="zhipu/glm-4-plus">GLM-4 Plus</option>
              </optgroup>
              <optgroup label="xAI">
                <option value="x-ai/grok-4">Grok 4</option>
                <option value="x-ai/grok-3-mini">Grok 3 Mini</option>
              </optgroup>
              <optgroup label="Qwen (Alibaba)">
                <option value="qwen/qwen3-235b-a22b">Qwen 3 235B</option>
                <option value="qwen/qwen3-30b-a3b">Qwen 3 30B</option>
              </optgroup>
            </>}
            {llmProvider === 'openai' && <>
              <option value="gpt-5.4">GPT-5.4</option>
              <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
              <option value="o3-pro">o3 Pro</option>
              <option value="o3-mini">o3 Mini</option>
            </>}
            {llmProvider === 'anthropic' && <>
              <option value="claude-opus-4-20260301">Claude Opus 4.6</option>
              <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
              <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
            </>}
          </select>
        </div>
        <button class="btn-primary" onClick={handleValidateAndSave} disabled={saving} style={{ width: '100%' }}>
          {saving ? 'VALIDATING...' : saved ? 'SAVED ✓ KEYS VALID' : 'VALIDATE & SAVE'}
        </button>
      </div>

      {/* Languages */}
      <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div class="label">LANGUAGES</div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>I SPEAK</label>
            <select class="input-field" value={sourceLang} onChange={async (e) => {
              const val = (e.target as HTMLSelectElement).value;
              setSourceLang(val);
              await vb.setSetting('sourceLanguage', val);
            }}>
              <option value="auto">Auto-detect</option>
              {STT_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
          <div class="label" style={{ color: 'var(--text-disabled)', paddingBottom: 8 }}>→</div>
          <div style={{ flex: 1 }}>
            <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>TRANSLATE TO</label>
            <select class="input-field" value={targetLang} onChange={async (e) => {
              const val = (e.target as HTMLSelectElement).value;
              setTargetLang(val);
              await vb.setSetting('targetLanguage', val);
            }}>
              {TTS_LANGUAGES.filter(l => l.code !== sourceLang).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Voice Profiles — multi-voice */}
      <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div class="label">VOICE PROFILES</div>
          <span class="mono" style={{ fontSize: 'var(--caption)', color: 'var(--text-disabled)' }}>{voices.length} CLONE{voices.length !== 1 ? 'S' : ''}</span>
        </div>

        {loadingVoices ? (
          <div class="label" style={{ textAlign: 'center', padding: 'var(--space-sm) 0' }}>LOADING...</div>
        ) : voices.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
            {voices.map(v => {
              const isAct = v.voiceId === activeVoiceId;
              return (
                <div key={v.voiceId} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', padding: 'var(--space-sm)', background: isAct ? 'var(--surface-raised)' : 'transparent', borderRadius: 'var(--radius-md)', border: isAct ? '1px solid var(--border-visible)' : '1px solid transparent' }}>
                  <div onClick={() => handleSelectVoice(v.voiceId)} style={{ width: 16, height: 16, borderRadius: '50%', cursor: 'pointer', flexShrink: 0, border: isAct ? '5px solid var(--success)' : '2px solid var(--border-visible)', background: isAct ? 'var(--black)' : 'transparent' }} />
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => handleSelectVoice(v.voiceId)}>
                    <div style={{ fontSize: 'var(--body-sm)', color: isAct ? 'var(--text-display)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                    <div class="mono" style={{ fontSize: '10px', color: 'var(--text-disabled)' }}>{v.voiceId.slice(0, 12)}...</div>
                  </div>
                  {isAct && <span class="label" style={{ color: 'var(--success)', flexShrink: 0 }}>ACTIVE</span>}
                  <button onClick={() => handleDeleteVoice(v.voiceId)} style={{ background: 'none', border: 'none', color: 'var(--text-disabled)', cursor: 'pointer', fontSize: 'var(--body)', padding: '4px', lineHeight: 1, flexShrink: 0 }} aria-label={'Delete ' + v.name}>✕</button>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--body-sm)' }}>No voice clones yet. Record below.</div>
        )}

        <div style={{ height: 1, background: 'var(--border)', margin: 'var(--space-xs) 0' }} />
        <div class="label">ADD NEW VOICE CLONE</div>
        <div style={{
          fontSize: '11px', color: 'var(--text-primary)', lineHeight: 1.5,
          background: 'var(--surface-raised)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: 'var(--space-sm)',
        }}>
          Read this aloud: "The quick brown fox jumps over the lazy dog. Technology has transformed the way we communicate across borders and languages. In today's interconnected world, the ability to speak and understand multiple languages opens doors to new opportunities."
        </div>
        {recording && (
          <div style={{ textAlign: 'center', padding: 'var(--space-xs) 0' }}>
            <div class="mono" style={{ fontSize: 'var(--heading)', color: 'var(--accent)', fontWeight: 700 }}>{fmtDur(recordingDuration)}</div>
            <div class="label" style={{ marginTop: 'var(--space-2xs)' }}>RECORDING...</div>
          </div>
        )}
        {hasRec && (
          <div style={{ textAlign: 'center', padding: 'var(--space-xs) 0' }}>
            <div class="mono" style={{ fontSize: 'var(--body)', color: 'var(--text-display)' }}>{fmtDur(recordingDuration)} recorded</div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          {!recording && !hasRec && <button class="btn-primary" onClick={handleStartRecording} style={{ width: '100%' }}>RECORD VOICE SAMPLE</button>}
          {recording && <button class="btn-primary" onClick={handleStopRecording} style={{ width: '100%', background: 'var(--accent)', color: '#fff' }}>STOP RECORDING</button>}
          {hasRec && (
            <>
              <button class="btn-primary" onClick={handleUploadVoice} disabled={uploading} style={{ width: '100%' }}>{uploading ? 'UPLOADING...' : 'CLONE MY VOICE'}</button>
              <button class="btn-secondary" onClick={handleStartRecording} style={{ width: '100%', fontSize: 'var(--caption)' }}>RE-RECORD</button>
            </>
          )}
        </div>
      </div>

      {error && <div class="mono" style={{ color: 'var(--accent)', fontSize: 'var(--caption)' }}>{error}</div>}
    </div>
  );
}


function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Determine equalizer mode from routing/echo state
  // In a real session: 'original' when mic is active (MUTED/capturing for STT),
  // 'translated' when TTS is playing
  const [eqMode, setEqMode] = useState<'original' | 'translated' | 'idle'>('idle');
  const [installError, setInstallError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installPercent, setInstallPercent] = useState(0);
  const [installMessage, setInstallMessage] = useState('');

  // Load initial settings
  useEffect(() => {
    (async () => {
      try {
        const onboarded = await vb.getSetting('onboardingComplete') as boolean;
        const elKey = await vb.getSetting('elevenLabsApiKey') as string;
        const hasKeys = Boolean(elKey && elKey.length > 0);

        dispatch({ type: 'SET_API_KEYS', hasKeys });
        dispatch({ type: 'SET_ONBOARDING', complete: onboarded && hasKeys });

        const src = await vb.getSetting('sourceLanguage') as string;
        const tgt = await vb.getSetting('targetLanguage') as string;
        dispatch({ type: 'SET_LANGUAGES', source: src ?? 'auto', target: tgt ?? 'es' });

        try {
          const driverStatus = await vb.getDriverStatus();
          dispatch({ type: 'SET_DRIVER', installed: driverStatus.state === 'installed' });
        } catch { /* driver check failed — not critical */ }
      } catch (err) {
        console.error('[VB] Settings load failed:', err);
      } finally {
        dispatch({ type: 'SET_LOADED' });
      }
    })();
  }, []);

  // Subscribe to IPC events
  useEffect(() => {
    const unsubs = [
      vb.on('session:state-changed', (data: unknown) => {
        const s = data as { active: boolean };
        dispatch({ type: 'SET_SESSION', active: s.active });
        if (!s.active) setEqMode('idle');
      }),
      vb.on('pipeline:latency-update', (data: unknown) => {
        const m = data as { totalMs: number };
        dispatch({ type: 'SET_LATENCY', ms: m.totalMs });
      }),
      vb.on('connection:state-changed', (data: unknown) => {
        const c = data as { service: string; state: { status: string } };
        dispatch({ type: 'SET_CONNECTION', service: c.service, status: c.state.status });
      }),
      vb.on('pipeline:degradation-changed', (data: unknown) => {
        const d = data as { level: string };
        dispatch({ type: 'SET_DEGRADATION', level: d.level });
      }),
      vb.on('audio:level', (data: unknown) => {
        const a = data as { vadState: string };
        if (a.vadState === 'speech' || a.vadState === 'speech-pending') {
          setEqMode('original');
        }
      }),
      vb.on('pipeline:stage-update', (data: unknown) => {
        const s = data as { stage: string };
        if (s.stage === 'SYNTHESIZED' || s.stage === 'PLAYED') {
          setEqMode('translated');
        } else if (s.stage === 'CAPTURED') {
          setEqMode('original');
        }
      }),
      vb.on('driver:install-progress', (data: unknown) => {
        const d = data as { percent: number; message: string };
        setInstallPercent(d.percent);
        setInstallMessage(d.message);
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, []);

  // Auto-reset eq mode after TTS finishes
  useEffect(() => {
    if (eqMode === 'translated') {
      const timer = setTimeout(() => setEqMode(state.sessionActive ? 'original' : 'idle'), 2000);
      return () => clearTimeout(timer);
    }
  }, [eqMode, state.sessionActive]);

  const handleToggle = useCallback(async () => {
    if (!state.hasApiKeys) {
      dispatch({ type: 'SET_VIEW', view: 'settings' });
      return;
    }
    if (state.sessionActive) {
      await vb.stopSession('user');
      setEqMode('idle');
    } else {
      await vb.startSession({
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
      });
      setEqMode('original');
    }
  }, [state.sessionActive, state.sourceLanguage, state.targetLanguage, state.hasApiKeys]);

  const handleOnboardingComplete = useCallback(() => {
    dispatch({ type: 'SET_API_KEYS', hasKeys: true });
    dispatch({ type: 'SET_ONBOARDING', complete: true });
  }, []);

  // Loading — animated splash while settings load
  if (state.loading) {
    return (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', background: 'var(--black)', gap: 'var(--space-lg)',
      }}>
        <style>{`
          @keyframes spinRing { to { transform: rotate(360deg); } }
          @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(12px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes pulseGlow {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
          }
          .splash-ring {
            width: 56px; height: 56px; border-radius: 50%;
            border: 2px solid var(--border);
            border-top-color: var(--text-display);
            animation: spinRing 1s linear infinite;
          }
          .splash-dots {
            display: flex; gap: 6px; align-items: center;
          }
          .splash-dot {
            width: 4px; height: 4px; border-radius: 50%;
            background: var(--text-secondary);
            animation: pulseGlow 1.4s ease-in-out infinite;
          }
          .splash-dot:nth-child(2) { animation-delay: 0.2s; }
          .splash-dot:nth-child(3) { animation-delay: 0.4s; }
        `}</style>

        {/* Spinning ring */}
        <div class="splash-ring" />

        {/* Title */}
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 'var(--heading)',
          color: 'var(--text-display)', letterSpacing: 'var(--ls-heading)',
          animation: 'fadeInUp 0.5s ease-out both',
        }}>
          VOICEBRIDGE
        </div>

        {/* Status + animated dots */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', animation: 'fadeInUp 0.5s ease-out 0.15s both' }}>
          <span class="mono" style={{ color: 'var(--text-disabled)', fontSize: 'var(--caption)' }}>
            LOADING
          </span>
          <div class="splash-dots">
            <div class="splash-dot" />
            <div class="splash-dot" />
            <div class="splash-dot" />
          </div>
        </div>
      </div>
    );
  }

  // Show onboarding if not completed
  if (state.view === 'onboarding' && !state.onboardingComplete) {
    return <OnboardingView onComplete={handleOnboardingComplete} />;
  }

  // Show settings
  if (state.view === 'settings') {
    return <SettingsView onBack={() => dispatch({ type: 'SET_VIEW', view: 'main' })} />;
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: 'var(--space-lg)',
      gap: 'var(--space-md)',
      overflow: 'auto',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 32 }}>
        <div style={{
          fontFamily: "'Doto', 'Space Mono', monospace",
          fontSize: 24,
          color: 'var(--text-display)',
          letterSpacing: '-0.01em',
          lineHeight: 1,
        }}>
          VOICEBRIDGE
        </div>
        <SessionToggle active={state.sessionActive} onToggle={handleToggle} disabled={!state.hasApiKeys} />
      </div>

      {/* No API keys warning */}
      {!state.hasApiKeys && (
        <div class="card" style={{ textAlign: 'center' }}>
          <div class="label" style={{ marginBottom: 'var(--space-sm)' }}>NO API KEYS CONFIGURED</div>
          <button class="btn-primary" onClick={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}>
            ENTER API KEYS
          </button>
        </div>
      )}

      {/* Language Pair — clickable selectors */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <div style={{ flex: 1 }}>
          <div class="label" style={{ marginBottom: 'var(--space-2xs)' }}>I SPEAK</div>
          <select class="input-field" style={{ fontSize: '13px', padding: '6px 0' }}
            value={state.sourceLanguage}
            onChange={async (e) => {
              const val = (e.target as HTMLSelectElement).value;
              dispatch({ type: 'SET_LANGUAGES', source: val, target: state.targetLanguage });
              await vb.setSetting('sourceLanguage', val);
            }}>
            <option value="auto">Auto-detect</option>
            {STT_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </div>
        <div class="label" style={{ color: 'var(--text-disabled)', paddingTop: 18 }}>→</div>
        <div style={{ flex: 1 }}>
          <div class="label" style={{ marginBottom: 'var(--space-2xs)' }}>TRANSLATE TO</div>
          <select class="input-field" style={{ fontSize: '13px', padding: '6px 0' }}
            value={state.targetLanguage}
            onChange={async (e) => {
              const val = (e.target as HTMLSelectElement).value;
              dispatch({ type: 'SET_LANGUAGES', source: state.sourceLanguage, target: val });
              await vb.setSetting('targetLanguage', val);
            }}>
            {TTS_LANGUAGES.filter(l => l.code !== state.sourceLanguage).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </div>
      </div>

      {/* Equalizer Visualizer */}
      <Equalizer active={state.sessionActive} mode={eqMode} />
      <EqLegend mode={eqMode} />

      {/* Latency Display */}
      <LatencyDisplay ms={state.latencyMs} color={state.latencyColor} />

      {/* Connection Status */}
      <ConnectionStatus stt={state.sttStatus} tts={state.ttsStatus} llm={state.llmStatus} />

      {/* Degradation Label */}
      <DegradationLabel level={state.degradationLevel} />

      {/* Driver Status */}
      {!state.driverInstalled && (
        <div class="card" style={{ textAlign: 'center' }}>
          <div class="label" style={{ marginBottom: 'var(--space-sm)' }}>VIRTUAL MIC NOT INSTALLED</div>

          {!installing ? (
            <>
              <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--caption)', marginBottom: 'var(--space-sm)' }}>
                Installs a virtual audio device on your system
              </div>
              <button class="btn-primary" onClick={async () => {
                setInstalling(true);
                setInstallError('');
                setInstallPercent(0);
                setInstallMessage('Starting...');
                const result = await vb.installDriver();
                if (result.success) {
                  setInstallPercent(100);
                  setInstallMessage(result.requiresReboot ? 'Installed! Restart your computer, then select "BlackHole 2ch" as mic.' : 'Done! Select "VoiceBridge Mic" in your meeting app.');
                  dispatch({ type: 'SET_DRIVER', installed: true });
                } else {
                  setInstalling(false);
                  setInstallError(result.error ?? 'Unknown error');
                }
              }} style={{ width: '100%' }}>
                INSTALL DRIVER
              </button>
            </>
          ) : (
            <>
              {/* Progress bar */}
              <div style={{ width: '100%', height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', marginBottom: 'var(--space-sm)' }}>
                <div style={{
                  height: '100%',
                  width: `${installPercent}%`,
                  background: installPercent >= 100 ? 'var(--success)' : 'var(--text-display)',
                  borderRadius: 3,
                  transition: 'width 0.5s ease-out',
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span class="mono" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {installMessage}
                </span>
                <span class="mono" style={{ fontSize: '11px', color: 'var(--text-display)' }}>
                  {installPercent}%
                </span>
              </div>
            </>
          )}

          {installError && (
            <div class="mono" style={{ color: 'var(--accent)', fontSize: '11px', marginTop: 'var(--space-sm)', wordBreak: 'break-word', whiteSpace: 'pre-wrap', textAlign: 'left', lineHeight: 1.5, background: 'var(--surface)', padding: 'var(--space-sm)', borderRadius: 'var(--radius-md)' }}>
              {installError}
            </div>
          )}
        </div>
      )}
      {state.driverInstalled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2xs)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
            <span class="mono status-green" style={{ fontSize: 'var(--caption)' }}>●</span>
            <span class="label">VIRTUAL MIC READY</span>
          </div>
          <div class="mono" style={{ fontSize: '10px', color: 'var(--text-disabled)', paddingLeft: 16 }}>
            Select "BlackHole 2ch" (macOS) / "VoiceBridge Mic" (Linux) / "CABLE Output" (Windows) in your meeting app
          </div>
        </div>
      )}

      {/* Settings button */}
      <div style={{ marginTop: 'auto', textAlign: 'center' }}>
        <button
          class="btn-secondary"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}
          style={{ fontSize: 'var(--caption)' }}
        >
          SETTINGS
        </button>
      </div>
    </div>
  );
}

// ── Mount ───────────────────────────────────────────────────

const root = document.getElementById('app');
if (root) render(<App />, root);
