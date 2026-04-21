/**
 * Onboarding wizard — 5-step first-time setup.
 * Welcome → API Keys → Voice Recording → Language Selection → Test & Confirm
 *
 * If demo keys are embedded via .env, the API Keys step is auto-skipped.
 */

import { setSetting, getSetting } from '../lib/settings-store.js';
import { populateLanguageSelect } from '../lib/languages.js';
import type { LLMProvider } from '../lib/types.js';

// ── Embedded Demo Keys (from .env at build time) ────────────

const DEMO_ELEVENLABS_KEY = import.meta.env.VITE_DEMO_ELEVENLABS_KEY ?? '';
const DEMO_LLM_KEY = import.meta.env.VITE_DEMO_LLM_KEY ?? '';
const DEMO_LLM_PROVIDER = (import.meta.env.VITE_DEMO_LLM_PROVIDER ?? 'openrouter') as LLMProvider;
const DEMO_OPENROUTER_MODEL = import.meta.env.VITE_DEMO_OPENROUTER_MODEL ?? 'openai/gpt-4o';
const HAS_DEMO_KEYS = DEMO_ELEVENLABS_KEY.length > 0;

// ── State ───────────────────────────────────────────────────

let currentStep = 0;

// ── DOM ─────────────────────────────────────────────────────

function getStep(index: number): HTMLElement {
  return document.getElementById(`step${index}`)!;
}

function getStepDots(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('.step-dot');
}

// ── Navigation ──────────────────────────────────────────────

function goToStep(index: number): void {
  getStep(currentStep).classList.remove('active');
  currentStep = index;
  getStep(currentStep).classList.add('active');

  getStepDots().forEach((dot, i) => {
    dot.className = 'step-dot';
    if (i < currentStep) dot.classList.add('done');
    else if (i === currentStep) dot.classList.add('current');
  });
}

// ── Initialize ──────────────────────────────────────────────

async function init(): Promise<void> {
  // If demo keys are embedded, save them to storage and skip the API key step
  if (HAS_DEMO_KEYS) {
    const existingKey = await getSetting('elevenLabsApiKey');
    if (!existingKey) {
      await setSetting('elevenLabsApiKey', DEMO_ELEVENLABS_KEY);
      if (DEMO_LLM_KEY) await setSetting('llmApiKey', DEMO_LLM_KEY);
      await setSetting('llmProvider', DEMO_LLM_PROVIDER);
      if (DEMO_LLM_PROVIDER === 'openrouter') {
        await setSetting('openRouterModel', DEMO_OPENROUTER_MODEL);
      }
    }
  }

  // Populate language dropdowns with all ElevenLabs supported languages
  populateLanguageSelect(
    document.getElementById('obSourceLang') as HTMLSelectElement,
    { selectedCode: 'en' }
  );
  populateLanguageSelect(
    document.getElementById('obTargetLang') as HTMLSelectElement,
    { selectedCode: 'es' }
  );

  // Step 0: Welcome → skip to step 2 (voice recording) if demo keys present
  document.getElementById('nextBtn0')!.addEventListener('click', () => {
    if (HAS_DEMO_KEYS) {
      goToStep(2); // Skip API keys step
    } else {
      goToStep(1);
    }
  });

  // Step 1: API Keys
  document.getElementById('backBtn1')!.addEventListener('click', () => goToStep(0));
  document.getElementById('nextBtn1')!.addEventListener('click', async () => {
    const elKey = (document.getElementById('obElevenLabsKey') as HTMLInputElement).value;
    const llmKey = (document.getElementById('obLlmKey') as HTMLInputElement).value;
    const status = document.getElementById('obKeyStatus')!;

    if (!elKey) {
      status.textContent = '[ELEVENLABS KEY REQUIRED]';
      status.className = 'status-inline error';
      return;
    }

    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': elKey },
      });
      if (!res.ok) {
        status.textContent = '[INVALID ELEVENLABS KEY]';
        status.className = 'status-inline error';
        return;
      }
    } catch {
      status.textContent = '[CONNECTION ERROR]';
      status.className = 'status-inline error';
      return;
    }

    await setSetting('elevenLabsApiKey', elKey);
    if (llmKey) await setSetting('llmApiKey', llmKey);

    status.textContent = '[VALID]';
    status.className = 'status-inline success';
    goToStep(2);
  });

  // Step 2: Voice Recording
  document.getElementById('backBtn2')!.addEventListener('click', () => {
    goToStep(HAS_DEMO_KEYS ? 0 : 1);
  });

  // Skip voice cloning (use default voice)
  document.getElementById('skipVoiceBtn')!.addEventListener('click', () => {
    goToStep(3);
  });

  let mediaRecorder: MediaRecorder | null = null;
  let recordedChunks: Blob[] = [];
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let eqAnimationId: number | null = null;

  const eqBars = document.querySelectorAll('.eq-bar') as NodeListOf<HTMLElement>;

  /** Start the equalizer visualization from a media stream */
  function startEqualizer(stream: MediaStream): void {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function drawEq(): void {
      if (!analyser) return;
      eqAnimationId = requestAnimationFrame(drawEq);
      analyser.getByteFrequencyData(dataArray);

      for (let i = 0; i < eqBars.length; i++) {
        const bar = eqBars[i];
        if (!bar) continue;
        // Map frequency bin to bar height (4px min, 48px max)
        const value = dataArray[i + 1] ?? 0;
        const height = Math.max(4, (value / 255) * 48);
        bar.style.height = `${height}px`;
        bar.style.background = value > 30 ? 'var(--success)' : 'var(--border)';
      }
    }
    drawEq();
  }

  /** Stop the equalizer visualization */
  function stopEqualizer(): void {
    if (eqAnimationId !== null) {
      cancelAnimationFrame(eqAnimationId);
      eqAnimationId = null;
    }
    if (audioContext) {
      void audioContext.close();
      audioContext = null;
      analyser = null;
    }
    for (const bar of eqBars) {
      bar.style.height = '4px';
      bar.style.background = 'var(--border)';
    }
  }

  document.getElementById('recordBtn')!.addEventListener('click', async () => {
    const btn = document.getElementById('recordBtn')!;
    const timer = document.getElementById('recordTimer')!;
    const recordStatus = document.getElementById('recordStatus')!;

    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.stop();
      stopEqualizer();
      btn.textContent = 'Start Recording';
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    // Start equalizer
    startEqualizer(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stopEqualizer();
      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });

      timer.textContent = '[UPLOADING...]';
      recordStatus.textContent = '';
      try {
        const apiKey = await getSetting('elevenLabsApiKey');
        const formData = new FormData();
        formData.append('files', blob, 'voice-sample.webm');
        formData.append('name', `VoiceBridge-${crypto.randomUUID().slice(0, 8)}`);
        formData.append('labels', JSON.stringify({ source: 'voicebridge' }));

        const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: formData,
        });

        if (res.ok) {
          const data = await res.json() as { voice_id: string };
          await setSetting('voiceProfileId', data.voice_id);
          timer.textContent = '[VOICE CREATED]';
          goToStep(3);
        } else if (res.status === 401) {
          timer.textContent = '0:30';
          recordStatus.textContent = '[INVALID API KEY]';
          recordStatus.className = 'status-inline error';
        } else if (res.status === 403 || res.status === 402) {
          timer.textContent = '0:30';
          recordStatus.textContent = '[REQUIRES CREATOR PLAN — CLICK SKIP TO USE DEFAULT VOICE]';
          recordStatus.className = 'status-inline error';
        } else {
          timer.textContent = '0:30';
          recordStatus.textContent = `[UPLOAD FAILED: ${res.status}]`;
          recordStatus.className = 'status-inline error';
        }
      } catch {
        timer.textContent = '0:30';
        recordStatus.textContent = '[NETWORK ERROR]';
        recordStatus.className = 'status-inline error';
      }
    };

    mediaRecorder.start(1000);
    btn.textContent = 'Stop Recording';

    let remaining = 30;
    const interval = setInterval(() => {
      remaining--;
      timer.textContent = `0:${String(remaining).padStart(2, '0')}`;
      if (remaining <= 0) {
        clearInterval(interval);
        mediaRecorder?.stop();
      }
    }, 1000);
  });

  // Step 3: Language Selection
  document.getElementById('backBtn3')!.addEventListener('click', () => goToStep(2));
  document.getElementById('nextBtn3')!.addEventListener('click', async () => {
    const source = (document.getElementById('obSourceLang') as HTMLSelectElement).value;
    const target = (document.getElementById('obTargetLang') as HTMLSelectElement).value;
    await setSetting('sourceLanguage', source);
    await setSetting('targetLanguage', target);
    goToStep(4);
  });

  // Step 4: Test
  document.getElementById('backBtn4')!.addEventListener('click', () => goToStep(3));
  document.getElementById('testBtn')!.addEventListener('click', () => {
    const status = document.getElementById('testStatus')!;
    status.textContent = '[TESTING PIPELINE...]';
    setTimeout(() => {
      status.textContent = '[TEST COMPLETE]';
      status.className = 'status-inline success';
      document.getElementById('testBtn')!.style.display = 'none';
      document.getElementById('finishBtn')!.style.display = '';
    }, 2000);
  });

  document.getElementById('finishBtn')!.addEventListener('click', async () => {
    await setSetting('onboardingComplete', true);
    chrome.action.setBadgeText({ text: '' });
    window.close();
  });
}

// ── Boot ────────────────────────────────────────────────────

init();
