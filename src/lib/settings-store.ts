/**
 * Typed settings store with AES-GCM-256 encryption for sensitive data.
 * Wraps chrome.storage.local and chrome.storage.sync.
 */

import type { LLMProvider, GlossaryEntry, DemoUsageState, DailyUsage } from './types.js';

// ── Schema ──────────────────────────────────────────────────

export interface SettingsSchema {
  // Encrypted (chrome.storage.local only)
  elevenLabsApiKey: string;
  llmApiKey: string;

  // Synced (chrome.storage.sync)
  llmProvider: LLMProvider;
  openRouterModel: string;
  sourceLanguage: string;
  targetLanguage: string;
  recentLanguages: string[];
  contextWindowSize: number;
  preserveTechnicalTerms: boolean;
  customGlossary: GlossaryEntry[];
  meetingContext: string;
  formalityLevel: 'formal' | 'informal';
  noiseGateThresholdDb: number;
  vadSensitivity: 'low' | 'medium' | 'high';
  echoCancellationMode: 'auto' | 'aggressive' | 'off';
  voiceStability: number;
  voiceSimilarityBoost: number;
  voiceStyle: number;
  latencyPriority: number;
  maxConcurrentRequests: 1 | 2 | 3;
  pushToTranslateKey: string;
  demoMode: boolean;
  ghostMode: boolean;
  rouletteLanguages: string[];
  theme: 'dark' | 'light' | 'system';

  // Local only (chrome.storage.local)
  voiceProfileId: string;
  installId: string;
  onboardingComplete: boolean;
  widgetPositions: Record<string, { x: number; y: number }>;
  languageCache: { stt: string[]; tts: string[]; cachedAt: number };
  demoUsage: DemoUsageState;
  dailyUsageHistory: DailyUsage[];
  extensionVersion: string;
  embeddedKeyExhausted: boolean;
  embeddedKeyLastChecked: number;
}

const ENCRYPTED_KEYS: ReadonlySet<keyof SettingsSchema> = new Set([
  'elevenLabsApiKey',
  'llmApiKey',
]);

const SYNCED_KEYS: ReadonlySet<keyof SettingsSchema> = new Set([
  'llmProvider', 'openRouterModel', 'sourceLanguage', 'targetLanguage', 'recentLanguages',
  'contextWindowSize', 'preserveTechnicalTerms', 'customGlossary',
  'meetingContext', 'formalityLevel', 'noiseGateThresholdDb',
  'vadSensitivity', 'echoCancellationMode', 'voiceStability',
  'voiceSimilarityBoost', 'voiceStyle', 'latencyPriority',
  'maxConcurrentRequests', 'pushToTranslateKey', 'demoMode',
  'ghostMode', 'rouletteLanguages', 'theme',
]);

const DEFAULTS: Partial<SettingsSchema> = {
  llmProvider: 'openai',
  openRouterModel: 'openai/gpt-4o',
  sourceLanguage: 'auto',
  targetLanguage: 'es',
  recentLanguages: [],
  contextWindowSize: 10,
  preserveTechnicalTerms: true,
  customGlossary: [],
  meetingContext: '',
  formalityLevel: 'informal',
  noiseGateThresholdDb: -40,
  vadSensitivity: 'medium',
  echoCancellationMode: 'auto',
  voiceStability: 0.5,
  voiceSimilarityBoost: 0.75,
  voiceStyle: 0.3,
  latencyPriority: 0.5,
  maxConcurrentRequests: 1,
  pushToTranslateKey: 'Ctrl+Space',
  demoMode: true,
  ghostMode: false,
  rouletteLanguages: ['en', 'ja', 'es', 'ar', 'fr', 'zh', 'de', 'ko', 'pt', 'hi'],
  theme: 'dark',
  onboardingComplete: false,
  widgetPositions: {},
  dailyUsageHistory: [],
  extensionVersion: '1.0.0',
  embeddedKeyExhausted: false,
  embeddedKeyLastChecked: 0,
};

// ── Encryption ──────────────────────────────────────────────

interface EncryptedValue {
  iv: string;
  ciphertext: string;
  salt: string;
}

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(chrome.runtime.id),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(plaintext: string): Promise<EncryptedValue> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );

  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    salt: btoa(String.fromCharCode(...salt)),
  };
}

async function decrypt(encrypted: EncryptedValue): Promise<string> {
  const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
  const salt = Uint8Array.from(atob(encrypted.salt), c => c.charCodeAt(0));

  const key = await deriveKey(salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

// ── Settings Store ──────────────────────────────────────────

/**
 * Get a setting value by key. Handles encryption and storage routing.
 */
export async function getSetting<K extends keyof SettingsSchema>(
  key: K
): Promise<SettingsSchema[K]> {
  if (ENCRYPTED_KEYS.has(key)) {
    const result = await chrome.storage.local.get(`encrypted_${key}`);
    const encrypted = result[`encrypted_${key}`] as EncryptedValue | undefined;
    if (!encrypted) return (DEFAULTS[key] ?? '') as SettingsSchema[K];
    try {
      return await decrypt(encrypted) as SettingsSchema[K];
    } catch {
      return (DEFAULTS[key] ?? '') as SettingsSchema[K];
    }
  }

  const storage = SYNCED_KEYS.has(key) ? chrome.storage.sync : chrome.storage.local;
  const result = await storage.get(key);
  return (result[key] ?? DEFAULTS[key]) as SettingsSchema[K];
}

/**
 * Set a setting value by key. Handles encryption and storage routing.
 */
export async function setSetting<K extends keyof SettingsSchema>(
  key: K,
  value: SettingsSchema[K]
): Promise<void> {
  if (ENCRYPTED_KEYS.has(key)) {
    const encrypted = await encrypt(value as string);
    await chrome.storage.local.set({ [`encrypted_${key}`]: encrypted });
    return;
  }

  const storage = SYNCED_KEYS.has(key) ? chrome.storage.sync : chrome.storage.local;
  await storage.set({ [key]: value });
}

/**
 * Get multiple settings at once.
 */
export async function getSettings<K extends keyof SettingsSchema>(
  keys: K[]
): Promise<Pick<SettingsSchema, K>> {
  const result = {} as Record<string, unknown>;
  for (const key of keys) {
    result[key] = await getSetting(key);
  }
  return result as Pick<SettingsSchema, K>;
}

/**
 * Initialize install ID on first run.
 */
export async function initializeInstall(): Promise<string> {
  const existing = await getSetting('installId');
  if (existing) return existing;

  const installId = crypto.randomUUID();
  await setSetting('installId', installId);
  await setSetting('demoUsage', {
    voiceTimeUsedMs: 0,
    windowStartTimestamp: 0,
    installId,
  });
  return installId;
}

/**
 * Export non-sensitive settings as JSON.
 */
export async function exportSettings(): Promise<string> {
  const syncResult = await chrome.storage.sync.get(null);
  return JSON.stringify(syncResult, null, 2);
}

/**
 * Import settings from JSON (excludes API keys).
 */
export async function importSettings(json: string): Promise<void> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  delete parsed['elevenLabsApiKey'];
  delete parsed['llmApiKey'];
  await chrome.storage.sync.set(parsed);
}
