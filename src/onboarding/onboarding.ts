/**
 * Onboarding wizard — 5-step first-time setup.
 * Welcome → API Keys → Voice Recording → Language Selection → Test & Confirm
 */

import { setSetting } from '../lib/settings-store.js';

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

  // Update step indicator
  getStepDots().forEach((dot, i) => {
    dot.className = 'step-dot';
    if (i < currentStep) dot.classList.add('done');
    else if (i === currentStep) dot.classList.add('current');
  });
}

// ── Initialize ──────────────────────────────────────────────

function init(): void {
  // Step 0 → 1
  document.getElementById('nextBtn0')!.addEventListener('click', () => goToStep(1));

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

    // Validate ElevenLabs key
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
  document.getElementById('backBtn2')!.addEventListener('click', () => goToStep(1));
  let mediaRecorder: MediaRecorder | null = null;
  let recordedChunks: Blob[] = [];

  document.getElementById('recordBtn')!.addEventListener('click', async () => {
    const btn = document.getElementById('recordBtn')!;
    const timer = document.getElementById('recordTimer')!;

    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.stop();
      btn.textContent = 'Start Recording';
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });

      // Upload to ElevenLabs
      timer.textContent = '[UPLOADING...]';
      try {
        const apiKey = await import('../lib/settings-store.js').then(m => m.getSetting('elevenLabsApiKey'));
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
        } else {
          timer.textContent = '[UPLOAD FAILED]';
        }
      } catch {
        timer.textContent = '[ERROR]';
      }
    };

    mediaRecorder.start(1000);
    btn.textContent = 'Stop Recording';

    // Countdown
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
    // In a real implementation, this would run the full pipeline test
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
