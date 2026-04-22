/**
 * Options/Settings page controller.
 * Handles API key management, voice profile, tuning, and configuration.
 */

import { getSetting, setSetting, exportSettings, importSettings } from '../lib/settings-store.js';

// ── DOM Elements ────────────────────────────────────────────

const elevenLabsKeyInput = document.getElementById('elevenLabsKey') as HTMLInputElement;
const llmProviderSelect = document.getElementById('llmProvider') as HTMLSelectElement;
const openRouterModelInput = document.getElementById('openRouterModel') as HTMLInputElement;
const openRouterModelField = document.getElementById('openRouterModelField')!;
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
  toggleOpenRouterField(llmProvider);

  const openRouterModel = await getSetting('openRouterModel');
  if (openRouterModel) openRouterModelInput.value = openRouterModel;

  const llmKey = await getSetting('llmApiKey');
  if (llmKey) llmKeyInput.value = '••••••••';

  // Voice profile status
  const voiceId = await getSetting('voiceProfileId');
  const voiceStatusEl = document.getElementById('voiceProfileStatus')!;
  const previewBtn = document.getElementById('previewVoiceBtn') as HTMLButtonElement;
  const deleteBtn = document.getElementById('deleteVoiceBtn') as HTMLButtonElement;
  if (voiceId) {
    voiceStatusEl.textContent = `[READY] ${voiceId.slice(0, 8)}...`;
    voiceStatusEl.className = 'status-inline success';
    previewBtn.disabled = false;
    deleteBtn.disabled = false;
  }

  stabilitySlider.value = String(Math.round((await getSetting('voiceStability')) * 100));
  similaritySlider.value = String(Math.round((await getSetting('voiceSimilarityBoost')) * 100));
  styleSlider.value = String(Math.round((await getSetting('voiceStyle')) * 100));
  noiseGateSlider.value = String(await getSetting('noiseGateThresholdDb'));
  contextWindowSlider.value = String(await getSetting('contextWindowSize'));

  updateSliderDisplays();
  setupEventListeners();
}

// ── Helpers ──────────────────────────────────────────────────

function toggleOpenRouterField(provider: string): void {
  openRouterModelField.style.display = provider === 'openrouter' ? '' : 'none';
}

// ── Event Listeners ─────────────────────────────────────────

function setupEventListeners(): void {
  // Show/hide OpenRouter model field based on provider selection
  llmProviderSelect.addEventListener('change', () => {
    toggleOpenRouterField(llmProviderSelect.value);
  });

  // API key validation
  validateKeysBtn.addEventListener('click', async () => {
    // Save keys first
    if (elevenLabsKeyInput.value && !elevenLabsKeyInput.value.startsWith('••')) {
      await setSetting('elevenLabsApiKey', elevenLabsKeyInput.value);
    }
    if (llmKeyInput.value && !llmKeyInput.value.startsWith('••')) {
      await setSetting('llmApiKey', llmKeyInput.value);
    }
    await setSetting('llmProvider', llmProviderSelect.value as 'openai' | 'anthropic' | 'openrouter');
    if (llmProviderSelect.value === 'openrouter') {
      await setSetting('openRouterModel', openRouterModelInput.value);
    }

    // Validate ElevenLabs
    try {
      const key = await getSetting('elevenLabsApiKey');
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': key },
      });
      if (res.ok) {
        elevenLabsStatus.textContent = '[VALID]';
        elevenLabsStatus.className = 'status-inline success';
        // Clear exhaustion flag on successful validation
        await setSetting('embeddedKeyExhausted', false);
      } else if (res.status === 402) {
        // Embedded key exhausted — flag it and prompt for personal key
        await setSetting('embeddedKeyExhausted', true);
        await setSetting('embeddedKeyLastChecked', Date.now());
        elevenLabsStatus.textContent = '[KEY EXHAUSTED — ENTER YOUR OWN KEY]';
        elevenLabsStatus.className = 'status-inline error';
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

  // Voice Profile buttons
  document.getElementById('recordVoiceBtn')!.addEventListener('click', async () => {
    const statusEl = document.getElementById('voiceProfileStatus')!;
    const previewBtnEl = document.getElementById('previewVoiceBtn') as HTMLButtonElement;
    const deleteBtnEl = document.getElementById('deleteVoiceBtn') as HTMLButtonElement;

    try {
      statusEl.textContent = '[RECORDING... SPEAK FOR 30 SECONDS]';
      statusEl.className = 'status-inline';

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      recorder.start(1000);

      // Auto-stop after 30 seconds
      await new Promise<void>((resolve) => {
        setTimeout(() => { recorder.stop(); resolve(); }, 30000);
        recorder.onstop = () => resolve();
      });

      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(chunks, { type: 'audio/webm' });

      statusEl.textContent = '[UPLOADING...]';
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
        statusEl.textContent = `[READY] ${data.voice_id.slice(0, 8)}...`;
        statusEl.className = 'status-inline success';
        previewBtnEl.disabled = false;
        deleteBtnEl.disabled = false;
      } else {
        statusEl.textContent = `[FAILED: ${res.status}]`;
        statusEl.className = 'status-inline error';
      }
    } catch (err) {
      statusEl.textContent = `[ERROR: ${err instanceof Error ? err.message : 'unknown'}]`;
      statusEl.className = 'status-inline error';
    }
  });

  document.getElementById('deleteVoiceBtn')!.addEventListener('click', async () => {
    const statusEl = document.getElementById('voiceProfileStatus')!;
    const voiceId = await getSetting('voiceProfileId');
    if (!voiceId) return;

    try {
      const apiKey = await getSetting('elevenLabsApiKey');
      await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
      });
      await setSetting('voiceProfileId', '');
      statusEl.textContent = '[NOT SET UP]';
      statusEl.className = 'status-inline';
      (document.getElementById('previewVoiceBtn') as HTMLButtonElement).disabled = true;
      (document.getElementById('deleteVoiceBtn') as HTMLButtonElement).disabled = true;
    } catch {
      statusEl.textContent = '[DELETE FAILED]';
      statusEl.className = 'status-inline error';
    }
  });

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
