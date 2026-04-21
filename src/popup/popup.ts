/**
 * Popup UI controller.
 * Handles toggle, language selection, status display, and demo quota.
 */

import { initMessageBus, sendMessage, onMessage } from '../lib/message-bus.js';
import { getSetting, setSetting } from '../lib/settings-store.js';
import type { SessionState } from '../lib/types.js';

// ── DOM Elements ────────────────────────────────────────────

const mainToggle = document.getElementById('mainToggle') as HTMLButtonElement;
const sourceLanguage = document.getElementById('sourceLanguage') as HTMLSelectElement;
const targetLanguage = document.getElementById('targetLanguage') as HTMLSelectElement;
const latencyEl = document.getElementById('latency')!;
const voiceStatusEl = document.getElementById('voiceStatus')!;
const sttDot = document.getElementById('sttDot')!;
const ttsDot = document.getElementById('ttsDot')!;
const llmDot = document.getElementById('llmDot')!;
const sessionDurationEl = document.getElementById('sessionDuration')!;
const voiceTimeEl = document.getElementById('voiceTimeRemaining')!;
const settingsBtn = document.getElementById('settingsBtn')!;
const ghostModeBtn = document.getElementById('ghostModeBtn')!;
const rouletteBtn = document.getElementById('rouletteBtn')!;

// ── State ───────────────────────────────────────────────────

let sessionActive = false;
let sessionStartTime = 0;
let durationInterval: ReturnType<typeof setInterval> | null = null;

// ── Initialize ──────────────────────────────────────────────

async function init(): Promise<void> {
  initMessageBus();

  // Load saved language preferences
  const source = await getSetting('sourceLanguage');
  const target = await getSetting('targetLanguage');
  if (source) sourceLanguage.value = source;
  if (target) targetLanguage.value = target;

  // Check onboarding status
  const onboarded = await getSetting('onboardingComplete');
  if (!onboarded) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
    return;
  }

  setupEventListeners();
  setupMessageHandlers();
}

// ── Event Listeners ─────────────────────────────────────────

function setupEventListeners(): void {
  mainToggle.addEventListener('click', () => {
    sessionActive = !sessionActive;
    mainToggle.setAttribute('aria-checked', String(sessionActive));

    if (sessionActive) {
      sendMessage('SESSION_START', {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
      });
      sessionStartTime = Date.now();
      startDurationTimer();
    } else {
      sendMessage('SESSION_STOP', { reason: 'user' });
      stopDurationTimer();
    }
  });

  sourceLanguage.addEventListener('change', () => {
    setSetting('sourceLanguage', sourceLanguage.value);
    if (sessionActive) {
      sendMessage('LANGUAGE_CHANGED', {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
      });
    }
  });

  targetLanguage.addEventListener('change', () => {
    setSetting('targetLanguage', targetLanguage.value);
    if (sessionActive) {
      sendMessage('LANGUAGE_CHANGED', {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
      });
    }
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  ghostModeBtn.addEventListener('click', () => {
    sendMessage('GHOST_MODE_TOGGLE', { enabled: true });
  });

  rouletteBtn.addEventListener('click', () => {
    sendMessage('ROULETTE_START', { sentence: '', languages: [] });
  });
}

// ── Message Handlers ────────────────────────────────────────

function setupMessageHandlers(): void {
  onMessage('SESSION_STATE_CHANGED', (state: SessionState) => {
    sessionActive = state.active;
    mainToggle.setAttribute('aria-checked', String(state.active));
  });

  onMessage('LATENCY_UPDATE', (measurement) => {
    const ms = measurement.totalMs;
    latencyEl.textContent = `${ms}ms`;
    latencyEl.className = 'status-value';
    if (ms < 1500) latencyEl.classList.add('good');
    else if (ms < 2500) latencyEl.classList.add('moderate');
    else latencyEl.classList.add('poor');
  });

  onMessage('CONNECTION_STATE_CHANGED', ({ service, state }) => {
    const dot = service === 'stt' ? sttDot : service === 'tts' ? ttsDot : llmDot;
    dot.className = 'dot';
    if (state.status === 'connected') dot.classList.add('connected');
    else if (state.status === 'error') dot.classList.add('error');
  });

  onMessage('VOICE_PROFILE_STATUS', (state) => {
    voiceStatusEl.textContent = state.status === 'ready' ? 'Ready' : state.status.replace(/-/g, ' ');
  });

  onMessage('DEMO_TIME_UPDATE', ({ voiceTimeRemainingMs }) => {
    if (voiceTimeRemainingMs === Infinity) {
      voiceTimeEl.textContent = 'UNLIMITED';
      voiceTimeEl.style.color = 'var(--success)';
      return;
    }
    const seconds = Math.ceil(voiceTimeRemainingMs / 1000);
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    voiceTimeEl.textContent = `${min}:${String(sec).padStart(2, '0')} LEFT`;
  });

  onMessage('DEMO_LIMIT_REACHED', () => {
    voiceTimeEl.textContent = 'LIMIT REACHED';
    voiceTimeEl.style.color = 'var(--accent)';
    mainToggle.setAttribute('aria-checked', 'false');
    sessionActive = false;
    stopDurationTimer();
  });
}

// ── Duration Timer ──────────────────────────────────────────

function startDurationTimer(): void {
  durationInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    sessionDurationEl.textContent = `${min}:${String(sec).padStart(2, '0')}`;
  }, 1000);
}

function stopDurationTimer(): void {
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
}

// ── Boot ────────────────────────────────────────────────────

init();
