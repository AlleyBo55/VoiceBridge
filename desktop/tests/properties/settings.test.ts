/**
 * Property tests for settings store.
 * Properties 12, 13, 14, 15, 16
 * Feature: desktop-app-rewrite
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { DesktopSettingsStore } from '../../src/main/desktop-settings-store.js';
import { ENCRYPTED_SETTINGS_KEYS, DEFAULT_SETTINGS } from '../../src/shared/types.js';

let tempDir: string;
let store: DesktopSettingsStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'vb-test-'));
  store = new DesktopSettingsStore(tempDir);
  await store.initialize();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Property 12: Encryption round-trip preserves plaintext ──

describe('Property 12: Encryption round-trip preserves plaintext', () => {
  it('encrypting and decrypting API keys preserves the original value', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.length > 0),
        async (apiKey) => {
          await store.set('elevenLabsApiKey', apiKey);
          await store.flush();

          // Create a new store instance to force re-read from disk
          const store2 = new DesktopSettingsStore(tempDir);
          await store2.initialize();
          const retrieved = await store2.get('elevenLabsApiKey');
          expect(retrieved).toBe(apiKey);
        },
      ),
      { numRuns: 20 }, // Fewer runs due to I/O
    );
  });
});

// ── Property 13: Settings persistence round-trip ────────────

describe('Property 13: Settings persistence round-trip', () => {
  it('writing and reading settings preserves values', async () => {
    await store.set('sourceLanguage', 'fr');
    await store.set('targetLanguage', 'de');
    await store.set('voiceStability', 0.7);
    await store.set('ghostMode', true);
    await store.flush();

    const store2 = new DesktopSettingsStore(tempDir);
    await store2.initialize();

    expect(await store2.get('sourceLanguage')).toBe('fr');
    expect(await store2.get('targetLanguage')).toBe('de');
    expect(await store2.get('voiceStability')).toBe(0.7);
    expect(await store2.get('ghostMode')).toBe(true);
  });

  it('missing keys return defaults', async () => {
    const freshStore = new DesktopSettingsStore(tempDir);
    await freshStore.initialize();

    expect(await freshStore.get('sourceLanguage')).toBe(DEFAULT_SETTINGS.sourceLanguage);
    expect(await freshStore.get('noiseGateThresholdDb')).toBe(DEFAULT_SETTINGS.noiseGateThresholdDb);
  });
});

// ── Property 14: Settings export never contains sensitive fields ─

describe('Property 14: Settings export never contains sensitive fields', () => {
  it('exported JSON does not contain API keys', async () => {
    await store.set('elevenLabsApiKey', 'sk-secret-key-12345');
    await store.set('llmApiKey', 'sk-another-secret');
    await store.set('sourceLanguage', 'ja');
    await store.flush();

    const exported = await store.exportSettings();
    const parsed = JSON.parse(exported) as Record<string, unknown>;

    for (const key of ENCRYPTED_SETTINGS_KEYS) {
      expect(parsed).not.toHaveProperty(key);
    }

    // Non-sensitive settings should be present
    expect(parsed).toHaveProperty('sourceLanguage', 'ja');
  });

  it('property: no sensitive key name appears in export for any settings state', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        async (key1, key2) => {
          await store.set('elevenLabsApiKey', key1);
          await store.set('llmApiKey', key2);
          await store.flush();

          const exported = await store.exportSettings();
          const parsed = JSON.parse(exported) as Record<string, unknown>;
          // Sensitive key names must not appear as keys in the exported object
          expect(parsed).not.toHaveProperty('elevenLabsApiKey');
          expect(parsed).not.toHaveProperty('llmApiKey');
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ── Property 15: Settings import validates schema ───────────

describe('Property 15: Settings import validates schema and rejects invalid input', () => {
  it('rejects invalid JSON', async () => {
    await expect(store.importSettings('not json')).rejects.toThrow();
  });

  it('rejects non-object JSON', async () => {
    await expect(store.importSettings('"string"')).rejects.toThrow();
    await expect(store.importSettings('42')).rejects.toThrow();
    await expect(store.importSettings('[]')).rejects.toThrow();
  });

  it('rejects mistyped fields', async () => {
    // sourceLanguage should be string, not number
    await expect(store.importSettings('{"sourceLanguage": 42}')).rejects.toThrow();
  });

  it('accepts valid settings and strips sensitive keys', async () => {
    const json = JSON.stringify({
      sourceLanguage: 'fr',
      targetLanguage: 'de',
      elevenLabsApiKey: 'should-be-stripped',
    });

    await store.importSettings(json);
    expect(await store.get('sourceLanguage')).toBe('fr');
    expect(await store.get('targetLanguage')).toBe('de');
    // API key should NOT have been imported
    expect(await store.get('elevenLabsApiKey')).not.toBe('should-be-stripped');
  });
});

// ── Property 16: Settings migration produces valid schema ───

describe('Property 16: Settings migration produces valid schema', () => {
  it('migration from version 0 applies defaults for new fields', async () => {
    await store.migrateFromVersion(0);
    const all = await store.getAll();

    // All default fields should be present
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(all).toHaveProperty(key);
    }

    expect(all.settingsSchemaVersion).toBe(1);
  });

  it('migration preserves existing values', async () => {
    await store.set('sourceLanguage', 'ja');
    await store.set('voiceStability', 0.9);
    await store.flush();

    await store.migrateFromVersion(0);

    expect(await store.get('sourceLanguage')).toBe('ja');
    expect(await store.get('voiceStability')).toBe(0.9);
  });
});
