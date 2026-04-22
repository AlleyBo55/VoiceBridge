/**
 * Desktop settings store with AES-GCM-256 encryption for sensitive data.
 * Replaces chrome.storage with filesystem-based JSON + Node.js crypto.
 * Atomic writes prevent corruption from crashes during write.
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, randomUUID } from 'crypto';
import { hostname, userInfo } from 'os';
import { getConfigDir } from '../shared/platform.js';
import type { DesktopSettingsSchema } from '../shared/types.js';
import { DEFAULT_SETTINGS, ENCRYPTED_SETTINGS_KEYS } from '../shared/types.js';

// ── Constants ───────────────────────────────────────────────

const SETTINGS_FILE = 'settings.json';
const SALT_FILE = 'salt.bin';
const CURRENT_SCHEMA_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = 'sha256';
const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// ── Encryption ──────────────────────────────────────────────

interface EncryptedValue {
  iv: string;
  ciphertext: string;
  tag: string;
}

function getMachineIdentifier(): string {
  try {
    return `${hostname()}:${userInfo().username}`;
  } catch {
    return 'voicebridge-default-machine-id';
  }
}

async function getOrCreateSalt(configDir: string): Promise<Buffer> {
  const saltPath = join(configDir, SALT_FILE);
  if (existsSync(saltPath)) {
    return readFile(saltPath);
  }
  const salt = randomBytes(16);
  await mkdir(configDir, { recursive: true });
  await writeFile(saltPath, salt);
  return salt;
}


function deriveKey(salt: Buffer): Buffer {
  const machineId = getMachineIdentifier();
  return pbkdf2Sync(machineId, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
}

function encrypt(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  const tag = cipher.getAuthTag().toString('base64');
  return {
    iv: iv.toString('base64'),
    ciphertext,
    tag,
  };
}

function decrypt(encrypted: EncryptedValue, key: Buffer): string {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  let plaintext = decipher.update(encrypted.ciphertext, 'base64', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

// ── Settings Store ──────────────────────────────────────────

interface StoredSettings {
  schemaVersion: number;
  settings: Record<string, unknown>;
  encrypted: Record<string, EncryptedValue>;
}

export class DesktopSettingsStore {
  #configDir: string;
  #settingsPath: string;
  #cache: Partial<DesktopSettingsSchema> = {};
  #encryptionKey: Buffer | null = null;
  #initialized = false;
  #writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(configDir?: string) {
    this.#configDir = configDir ?? getConfigDir();
    this.#settingsPath = join(this.#configDir, SETTINGS_FILE);
  }

  /** Initialize the store — load settings from disk, derive encryption key. */
  async initialize(): Promise<void> {
    await mkdir(this.#configDir, { recursive: true });
    const salt = await getOrCreateSalt(this.#configDir);
    this.#encryptionKey = deriveKey(salt);
    await this.#loadFromDisk();
    this.#initialized = true;
  }

  /** Get a setting value by key. Handles decryption transparently. */
  async get<K extends keyof DesktopSettingsSchema>(key: K): Promise<DesktopSettingsSchema[K]> {
    if (!this.#initialized) await this.initialize();
    const value = this.#cache[key];
    if (value !== undefined) return value as DesktopSettingsSchema[K];
    return DEFAULT_SETTINGS[key];
  }

  /** Set a setting value by key. Handles encryption transparently. */
  async set<K extends keyof DesktopSettingsSchema>(key: K, value: DesktopSettingsSchema[K]): Promise<void> {
    if (!this.#initialized) await this.initialize();
    this.#cache[key] = value;
    this.#scheduleDiskWrite();
  }

  /** Get all settings (with defaults for missing keys). */
  async getAll(): Promise<DesktopSettingsSchema> {
    if (!this.#initialized) await this.initialize();
    return { ...DEFAULT_SETTINGS, ...this.#cache };
  }

  /** Force immediate write to disk. */
  async flush(): Promise<void> {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    await this.#writeToDisk();
  }

  /** Export non-sensitive settings as JSON string. */
  async exportSettings(): Promise<string> {
    const all = await this.getAll();
    const exported: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(all)) {
      if (!ENCRYPTED_SETTINGS_KEYS.has(key as keyof DesktopSettingsSchema)) {
        exported[key] = value;
      }
    }
    return JSON.stringify(exported, null, 2);
  }

  /** Import settings from JSON string. Validates schema, rejects invalid input. */
  async importSettings(json: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      throw new Error('Invalid JSON');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Settings must be a JSON object');
    }

    // Remove sensitive keys if present
    delete parsed['elevenLabsApiKey'];
    delete parsed['llmApiKey'];

    // Validate types against defaults
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      const defaultValue = DEFAULT_SETTINGS[key as keyof DesktopSettingsSchema];
      if (defaultValue !== null && defaultValue !== undefined && typeof value !== typeof defaultValue) {
        throw new Error(`Invalid type for setting "${key}": expected ${typeof defaultValue}, got ${typeof value}`);
      }
    }

    // Apply valid settings
    for (const [key, value] of Object.entries(parsed)) {
      if (key in DEFAULT_SETTINGS && !ENCRYPTED_SETTINGS_KEYS.has(key as keyof DesktopSettingsSchema)) {
        this.#cache[key as keyof DesktopSettingsSchema] = value as DesktopSettingsSchema[keyof DesktopSettingsSchema];
      }
    }

    await this.flush();
  }

  /** Migrate settings from an older schema version. */
  async migrateFromVersion(oldVersion: number): Promise<void> {
    if (oldVersion >= CURRENT_SCHEMA_VERSION) return;

    // Version 0 → 1: Add new fields with defaults
    if (oldVersion < 1) {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in this.#cache)) {
          this.#cache[key as keyof DesktopSettingsSchema] = value as DesktopSettingsSchema[keyof DesktopSettingsSchema];
        }
      }
      this.#cache.settingsSchemaVersion = CURRENT_SCHEMA_VERSION;
    }

    await this.flush();
  }

  /** Initialize install ID on first run. */
  async initializeInstall(): Promise<string> {
    const existing = await this.get('installId');
    if (existing) return existing;

    const installId = randomUUID();
    await this.set('installId', installId);
    return installId;
  }

  // ── Private Methods ─────────────────────────────────────────

  async #loadFromDisk(): Promise<void> {
    if (!existsSync(this.#settingsPath)) {
      this.#cache = { ...DEFAULT_SETTINGS };
      return;
    }

    try {
      const raw = await readFile(this.#settingsPath, 'utf8');
      const stored = JSON.parse(raw) as StoredSettings;

      // Load plaintext settings
      for (const [key, value] of Object.entries(stored.settings)) {
        this.#cache[key as keyof DesktopSettingsSchema] = value as DesktopSettingsSchema[keyof DesktopSettingsSchema];
      }

      // Decrypt encrypted settings
      if (this.#encryptionKey && stored.encrypted) {
        for (const [key, encrypted] of Object.entries(stored.encrypted)) {
          try {
            const plaintext = decrypt(encrypted, this.#encryptionKey);
            this.#cache[key as keyof DesktopSettingsSchema] = plaintext as DesktopSettingsSchema[keyof DesktopSettingsSchema];
          } catch {
            // Decryption failed — reset to default
            this.#cache[key as keyof DesktopSettingsSchema] = DEFAULT_SETTINGS[key as keyof DesktopSettingsSchema];
          }
        }
      }

      // Run migration if needed
      const version = stored.schemaVersion ?? 0;
      if (version < CURRENT_SCHEMA_VERSION) {
        await this.migrateFromVersion(version);
      }
    } catch {
      // Corrupt file — reset to defaults
      this.#cache = { ...DEFAULT_SETTINGS };
    }
  }

  async #writeToDisk(): Promise<void> {
    const stored: StoredSettings = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      settings: {},
      encrypted: {},
    };

    for (const [key, value] of Object.entries(this.#cache)) {
      if (ENCRYPTED_SETTINGS_KEYS.has(key as keyof DesktopSettingsSchema)) {
        if (this.#encryptionKey && typeof value === 'string' && value.length > 0) {
          stored.encrypted[key] = encrypt(value, this.#encryptionKey);
        }
      } else {
        stored.settings[key] = value;
      }
    }

    const json = JSON.stringify(stored, null, 2);
    const tmpPath = `${this.#settingsPath}.tmp`;

    // Atomic write: write to temp, then rename
    await writeFile(tmpPath, json, 'utf8');
    await rename(tmpPath, this.#settingsPath);
  }

  #scheduleDiskWrite(): void {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(async () => {
      this.#writeTimer = null;
      await this.#writeToDisk();
    }, 1000);
  }
}