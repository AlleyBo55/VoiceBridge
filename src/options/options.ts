/**
 * Options/Settings page controller.
 * Handles API key management, voice profile, tuning, and configuration.
 */

import { getSetting, setSetting, exportSettings, importSettings } from '../lib/settings-store.js';

// ── DOM Elements ────────────────────────────────────────────

const elevenLabsKeyInput = document.getElementById('elevenLabsKey') as HTMLInputElement;
const llmProviderSelect = document.getElementById('llmProvider') as HTMLSelectElement;
const llmKeyInput = document.getElementById('llmKey') as HTMLInputElement;
const validateKeysBtn = document.getElementById('validateKeysBtn')!;
const elevenLabsStatus = document.getElementById('elevenLabsStatus')!;
const llmStatus = document.getElementById('llmStatus')!;

const stabilitySlider = document.getElementById('stability') as HTMLInputElement;
const stabilityValue = document.getElementById('stabilityValue')!;
const similaritySlider = document.getElementById('similarity') as HTMLInputElement;
const similarityValue = document.getElementById('similarityValue')!;
const styleSlider = document.getElementById('style') as HTMLInputElement;
const styleValue = document.getElementById('styleValue')!;

const noiseGateSlider = document.getElementById('noiseGate') as HTMLInputElement;
const noiseGateValue = document.getElementById('noiseGateValue')!;
const contextWindowSlider = document.getElementById('contextWindow') as HTMLInputElement;
const contextWindowValue = document.getElementById('contextWindowValue')!;

const exportBtn = document.getElementById('exportBtn')!;
const importBtn = document.getElementById('importBtn')!;

// ── Initialize ──────────────────────────────────────────────

async function init(): Promise<void> {
  // Load saved values
  const elKey = await getSetting('elevenLabsApiKey');
  if (elKey) elevenLabsKeyInput.value = '••••••••';

  const llmProvider = await getSetting('llmProvider');
  llmProviderSelect.value = llmProvider;

  const llmKey = await getSetting('llmApiKey');
  if (llmKey) llmKeyInput.value = '••••••••';

  stabilitySlider.value = String(Math.round((await getSetting('voiceStability')) * 100));
  similaritySlider.value = String(Math.round((await getSetting('voiceSimilarityBoost')) * 100));
  styleSlider.value = String(Math.round((await getSetting('voiceStyle')) * 100));
  noiseGateSlider.value = String(await getSetting('noiseGateThresholdDb'));
  contextWindowSlider.value = String(await getSetting('contextWindowSize'));

  updateSliderDisplays();
  setupEventListeners();
}

// ── Event Listeners ─────────────────────────────────────────

function setupEventListeners(): void {
  // API key validation
  validateKeysBtn.addEventListener('click', async () => {
    // Save keys first
    if (elevenLabsKeyInput.value && !elevenLabsKeyInput.value.startsWith('••')) {
      await setSetting('elevenLabsApiKey', elevenLabsKeyInput.value);
    }
    if (llmKeyInput.value && !llmKeyInput.value.startsWith('••')) {
      await setSetting('llmApiKey', llmKeyInput.value);
    }
    await setSetting('llmProvider', llmProviderSelect.value as 'openai' | 'anthropic');

    // Validate ElevenLabs
    try {
      const key = await getSetting('elevenLabsApiKey');
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': key },
      });
      if (res.ok) {
        elevenLabsStatus.textContent = '[VALID]';
        elevenLabsStatus.className = 'status-inline success';
      } else {
        elevenLabsStatus.textContent = '[INVALID]';
        elevenLabsStatus.className = 'status-inline error';
      }
    } catch {
      elevenLabsStatus.textContent = '[ERROR]';
      elevenLabsStatus.className = 'status-inline error';
    }

    // Validate LLM
    llmStatus.textContent = '[SAVED]';
    llmStatus.className = 'status-inline success';
  });

  // Sliders
  const sliderHandler = (slider: HTMLInputElement, display: HTMLElement, settingKey: string, format: (v: number) => string, transform: (v: number) => number) => {
    slider.addEventListener('input', () => {
      const raw = Number(slider.value);
      display.textContent = format(raw);
      setSetting(settingKey as keyof import('../lib/settings-store.js').SettingsSchema, transform(raw) as never);
    });
  };

  sliderHandler(stabilitySlider, stabilityValue, 'voiceStability', v => (v / 100).toFixed(2), v => v / 100);
  sliderHandler(similaritySlider, similarityValue, 'voiceSimilarityBoost', v => (v / 100).toFixed(2), v => v / 100);
  sliderHandler(styleSlider, styleValue, 'voiceStyle', v => (v / 100).toFixed(2), v => v / 100);
  sliderHandler(noiseGateSlider, noiseGateValue, 'noiseGateThresholdDb', v => `${v}dB`, v => v);
  sliderHandler(contextWindowSlider, contextWindowValue, 'contextWindowSize', v => String(v), v => v);

  // Export/Import
  exportBtn.addEventListener('click', async () => {
    const json = await exportSettings();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voicebridge-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      await importSettings(text);
      window.location.reload();
    };
    input.click();
  });
}

function updateSliderDisplays(): void {
  stabilityValue.textContent = (Number(stabilitySlider.value) / 100).toFixed(2);
  similarityValue.textContent = (Number(similaritySlider.value) / 100).toFixed(2);
  styleValue.textContent = (Number(styleSlider.value) / 100).toFixed(2);
  noiseGateValue.textContent = `${noiseGateSlider.value}dB`;
  contextWindowValue.textContent = contextWindowSlider.value;
}

// ── Boot ────────────────────────────────────────────────────

init();
