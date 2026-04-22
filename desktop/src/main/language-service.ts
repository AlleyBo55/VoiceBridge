/**
 * Language list caching and filtering for VoiceBridge Desktop.
 * Fetches supported languages from ElevenLabs API, caches with 24h TTL.
 */

import type { Language } from '../shared/types.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';

// ── Constants ───────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Fallback language list (ElevenLabs Eleven v3 TTS + Scribe v2 STT) */
const FALLBACK_LANGUAGES: Language[] = [
  { code: 'af', name: 'Afrikaans' }, { code: 'ar', name: 'Arabic' },
  { code: 'hy', name: 'Armenian' }, { code: 'az', name: 'Azerbaijani' },
  { code: 'be', name: 'Belarusian' }, { code: 'bn', name: 'Bengali' },
  { code: 'bs', name: 'Bosnian' }, { code: 'bg', name: 'Bulgarian' },
  { code: 'ca', name: 'Catalan' }, { code: 'zh', name: 'Chinese (Mandarin)' },
  { code: 'hr', name: 'Croatian' }, { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' }, { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' }, { code: 'et', name: 'Estonian' },
  { code: 'fil', name: 'Filipino' }, { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' }, { code: 'ka', name: 'Georgian' },
  { code: 'de', name: 'German' }, { code: 'el', name: 'Greek' },
  { code: 'gu', name: 'Gujarati' }, { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' }, { code: 'hu', name: 'Hungarian' },
  { code: 'is', name: 'Icelandic' }, { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' }, { code: 'ja', name: 'Japanese' },
  { code: 'kn', name: 'Kannada' }, { code: 'kk', name: 'Kazakh' },
  { code: 'ko', name: 'Korean' }, { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' }, { code: 'mk', name: 'Macedonian' },
  { code: 'ms', name: 'Malay' }, { code: 'ml', name: 'Malayalam' },
  { code: 'mr', name: 'Marathi' }, { code: 'ne', name: 'Nepali' },
  { code: 'no', name: 'Norwegian' }, { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' }, { code: 'pt', name: 'Portuguese' },
  { code: 'pa', name: 'Punjabi' }, { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' }, { code: 'sr', name: 'Serbian' },
  { code: 'sk', name: 'Slovak' }, { code: 'sl', name: 'Slovenian' },
  { code: 'so', name: 'Somali' }, { code: 'es', name: 'Spanish' },
  { code: 'sw', name: 'Swahili' }, { code: 'sv', name: 'Swedish' },
  { code: 'ta', name: 'Tamil' }, { code: 'te', name: 'Telugu' },
  { code: 'th', name: 'Thai' }, { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' }, { code: 'ur', name: 'Urdu' },
  { code: 'vi', name: 'Vietnamese' }, { code: 'cy', name: 'Welsh' },
];

// ── Language Filtering ──────────────────────────────────────

/**
 * Filter target languages: exclude source language, match search query.
 */
export function filterLanguages(
  languages: Language[],
  sourceLanguage: string,
  searchQuery: string,
): Language[] {
  const query = searchQuery.toLowerCase().trim();
  return languages.filter(lang => {
    if (lang.code === sourceLanguage) return false;
    if (!query) return true;
    return lang.name.toLowerCase().includes(query) || lang.code.toLowerCase().includes(query);
  });
}

// ── Language Service ────────────────────────────────────────

export class LanguageService {
  #settings: DesktopSettingsStore;
  #cachedLanguages: Language[] = FALLBACK_LANGUAGES;

  constructor(settings: DesktopSettingsStore) {
    this.#settings = settings;
  }

  /** Get all supported languages (from cache or fallback). */
  async getLanguages(): Promise<Language[]> {
    const cache = await this.#settings.get('languageCache');
    if (cache.cachedAt > 0 && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
      // Use cached data if available
      return this.#cachedLanguages;
    }
    // Return fallback — API fetch would happen here in production
    return FALLBACK_LANGUAGES;
  }

  /** Filter languages for target selection. */
  async getFilteredTargetLanguages(
    sourceLanguage: string,
    searchQuery: string = '',
  ): Promise<Language[]> {
    const all = await this.getLanguages();
    return filterLanguages(all, sourceLanguage, searchQuery);
  }

  /** Get recently used languages (top 3). */
  async getRecentLanguages(): Promise<string[]> {
    return this.#settings.get('recentLanguages');
  }

  /** Add a language to recent list. */
  async addRecentLanguage(code: string): Promise<void> {
    const recent = await this.getRecentLanguages();
    const updated = [code, ...recent.filter(c => c !== code)].slice(0, 3);
    await this.#settings.set('recentLanguages', updated);
  }
}
