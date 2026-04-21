/**
 * Auto-populate embedded API keys from Vite build-time env vars
 * into chrome.storage on first install. Enables zero-configuration
 * demo usage for first-time users and hackathon judges.
 */

import { getSetting, setSetting } from './settings-store.js';
import type { LLMProvider } from './types.js';

const DEMO_ELEVENLABS_KEY = import.meta.env.VITE_DEMO_ELEVENLABS_KEY ?? '';
const DEMO_LLM_KEY = import.meta.env.VITE_DEMO_LLM_KEY ?? '';
const DEMO_LLM_PROVIDER = (import.meta.env.VITE_DEMO_LLM_PROVIDER ?? 'openrouter') as LLMProvider;
const DEMO_OPENROUTER_MODEL = import.meta.env.VITE_DEMO_OPENROUTER_MODEL ?? 'openai/gpt-4o';
const EXHAUSTION_RECHECK_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Check for embedded demo keys and populate storage if needed.
 * Called by the service worker on first install.
 *
 * Returns true if demo keys were populated, false if user keys exist
 * or no embedded keys are available.
 */
export async function bootstrapDemoKeys(): Promise<boolean> {
  if (!DEMO_ELEVENLABS_KEY) return false;

  const existingKey = await getSetting('elevenLabsApiKey');
  if (existingKey) return false;

  await setSetting('elevenLabsApiKey', DEMO_ELEVENLABS_KEY);
  if (DEMO_LLM_KEY) await setSetting('llmApiKey', DEMO_LLM_KEY);
  await setSetting('llmProvider', DEMO_LLM_PROVIDER);
  if (DEMO_LLM_PROVIDER === 'openrouter') {
    await setSetting('openRouterModel', DEMO_OPENROUTER_MODEL);
  }

  return true;
}

/**
 * Check if the embedded ElevenLabs key is exhausted.
 * Caches the result for 6 hours to avoid repeated API calls.
 * Makes a lightweight test call to the ElevenLabs user endpoint
 * to verify key status.
 *
 * @returns true if the embedded key is exhausted, false otherwise
 */
export async function checkEmbeddedKeyExhaustion(): Promise<boolean> {
  const exhausted = await getSetting('embeddedKeyExhausted');
  if (!exhausted) return false;

  const lastChecked = await getSetting('embeddedKeyLastChecked');
  if (Date.now() - lastChecked < EXHAUSTION_RECHECK_MS) return true;

  // Recheck by making a test API call
  try {
    const key = await getSetting('elevenLabsApiKey');
    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key },
    });
    if (res.status === 402) {
      await setSetting('embeddedKeyLastChecked', Date.now());
      return true;
    }
    // Key is working again
    await setSetting('embeddedKeyExhausted', false);
    return false;
  } catch {
    await setSetting('embeddedKeyLastChecked', Date.now());
    return true;
  }
}

/**
 * Check if demo keys are currently active (no user-provided keys).
 *
 * @returns true if the current ElevenLabs key matches the embedded demo key
 */
export async function isDemoMode(): Promise<boolean> {
  if (!DEMO_ELEVENLABS_KEY) return false;
  const currentKey = await getSetting('elevenLabsApiKey');
  return currentKey === DEMO_ELEVENLABS_KEY;
}
