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
  view: 'onboarding',
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
      style={{ opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
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
  const [elevenLabsKey, setElevenLabsKey] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [llmProvider, setLlmProvider] = useState('openrouter');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = useCallback(async () => {
    if (!elevenLabsKey.trim()) {
      setError('ElevenLabs API key is required');
      return;
    }
    if (!llmKey.trim()) {
      setError('LLM API key is required');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await vb.setSetting('elevenLabsApiKey', elevenLabsKey.trim());
      await vb.setSetting('llmApiKey', llmKey.trim());
      await vb.setSetting('llmProvider', llmProvider);
      await vb.setSetting('onboardingComplete', true);
      onComplete();
    } catch (err) {
      setError('Failed to save keys. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [elevenLabsKey, llmKey, llmProvider, onComplete]);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: 'var(--space-lg)',
      gap: 'var(--space-lg)',
    }}>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'var(--heading)',
        color: 'var(--text-display)',
        letterSpacing: 'var(--ls-heading)',
      }}>
        VOICEBRIDGE
      </div>

      <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--body-sm)' }}>
        Enter your API keys to get started. Keys are encrypted and stored locally — never sent anywhere except the API providers.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div>
          <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>
            ELEVENLABS API KEY
          </label>
          <input
            class="input-field"
            type="password"
            placeholder="sk-..."
            value={elevenLabsKey}
            onInput={(e) => setElevenLabsKey((e.target as HTMLInputElement).value)}
            autocomplete="off"
          />
        </div>

        <div>
          <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>
            LLM PROVIDER
          </label>
          <select
            class="input-field"
            value={llmProvider}
            onChange={(e) => setLlmProvider((e.target as HTMLSelectElement).value)}
          >
            <option value="openrouter">OpenRouter</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>

        <div>
          <label class="label" style={{ display: 'block', marginBottom: 'var(--space-xs)' }}>
            LLM API KEY
          </label>
          <input
            class="input-field"
            type="password"
            placeholder="sk-..."
            value={llmKey}
            onInput={(e) => setLlmKey((e.target as HTMLInputElement).value)}
            autocomplete="off"
          />
        </div>
      </div>

      {error && (
        <div class="mono" style={{ color: 'var(--accent)', fontSize: 'var(--caption)' }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 'auto' }}>
        <button
          class="btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{ width: '100%' }}
        >
          {saving ? 'SAVING...' : 'GET STARTED'}
        </button>
      </div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Load initial settings
  useEffect(() => {
    (async () => {
      const onboarded = await vb.getSetting('onboardingComplete') as boolean;
      const elKey = await vb.getSetting('elevenLabsApiKey') as string;
      const hasKeys = Boolean(elKey && elKey.length > 0);

      dispatch({ type: 'SET_API_KEYS', hasKeys });
      dispatch({ type: 'SET_ONBOARDING', complete: onboarded && hasKeys });

      const src = await vb.getSetting('sourceLanguage') as string;
      const tgt = await vb.getSetting('targetLanguage') as string;
      dispatch({ type: 'SET_LANGUAGES', source: src ?? 'auto', target: tgt ?? 'es' });

      const driverStatus = await vb.getDriverStatus();
      dispatch({ type: 'SET_DRIVER', installed: driverStatus.state === 'installed' });
    })();
  }, []);

  // Subscribe to IPC events
  useEffect(() => {
    const unsubs = [
      vb.on('session:state-changed', (data: unknown) => {
        const s = data as { active: boolean };
        dispatch({ type: 'SET_SESSION', active: s.active });
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
    ];
    return () => unsubs.forEach(fn => fn());
  }, []);

  const handleToggle = useCallback(async () => {
    if (!state.hasApiKeys) {
      dispatch({ type: 'SET_VIEW', view: 'onboarding' });
      return;
    }
    if (state.sessionActive) {
      await vb.stopSession('user');
    } else {
      await vb.startSession({
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
      });
    }
  }, [state.sessionActive, state.sourceLanguage, state.targetLanguage, state.hasApiKeys]);

  const handleOnboardingComplete = useCallback(() => {
    dispatch({ type: 'SET_API_KEYS', hasKeys: true });
    dispatch({ type: 'SET_ONBOARDING', complete: true });
  }, []);

  // Show onboarding if not completed
  if (state.view === 'onboarding' && !state.onboardingComplete) {
    return <OnboardingView onComplete={handleOnboardingComplete} />;
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: 'var(--space-lg)',
      gap: 'var(--space-md)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--heading)',
          color: 'var(--text-display)',
          letterSpacing: 'var(--ls-heading)',
        }}>
          VOICEBRIDGE
        </div>
        <SessionToggle active={state.sessionActive} onToggle={handleToggle} disabled={!state.hasApiKeys} />
      </div>

      {/* No API keys warning */}
      {!state.hasApiKeys && (
        <div class="card" style={{ textAlign: 'center' }}>
          <div class="label" style={{ marginBottom: 'var(--space-sm)' }}>NO API KEYS CONFIGURED</div>
          <button class="btn-primary" onClick={() => dispatch({ type: 'SET_VIEW', view: 'onboarding' })}>
            ENTER API KEYS
          </button>
        </div>
      )}

      {/* Language Pair */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <div class="label" style={{ flex: 1 }}>
          {state.sourceLanguage === 'auto' ? 'AUTO' : state.sourceLanguage.toUpperCase()}
        </div>
        <div class="label" style={{ color: 'var(--text-disabled)' }}>→</div>
        <div class="label" style={{ flex: 1, textAlign: 'right' }}>
          {state.targetLanguage.toUpperCase()}
        </div>
      </div>

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
          <button class="btn-primary" onClick={() => vb.installDriver()}>
            INSTALL DRIVER
          </button>
        </div>
      )}

      {/* Settings link */}
      <div style={{ marginTop: 'auto', textAlign: 'center' }}>
        <button
          class="btn-secondary"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'onboarding' })}
          style={{ fontSize: 'var(--caption)' }}
        >
          CHANGE API KEYS
        </button>
      </div>
    </div>
  );
}

// ── Mount ───────────────────────────────────────────────────

const root = document.getElementById('app');
if (root) render(<App />, root);
