/**
 * Translation model defaults, provider-aware model resolution, and the option lists the UI shows.
 * Shared by the main process (requests) and the renderer (pickers).
 */

import type { LLMProvider, TranslationEngineId, TTSModelId } from './types.js';

/**
 * Fast, cheap default per provider. Translation is latency-bound and one sentence long,
 * so the smallest current model of each family is the right default.
 * 'custom' has no default: the user's server decides which models exist.
 */
export const DEFAULT_LLM_MODELS: Readonly<Record<LLMProvider, string>> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
  openrouter: 'openai/gpt-6-luna',
  huggingface: 'Qwen/Qwen3.8-27B:fastest',
  custom: '',
};

/** OpenAI-compatible base URLs for the providers that speak the Chat Completions protocol. */
export const LLM_BASE_URLS: Readonly<Record<Exclude<LLMProvider, 'anthropic' | 'custom'>, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  huggingface: 'https://router.huggingface.co/v1',
};

/** Provider choices, in the order the UI lists them. */
export const LLM_PROVIDER_OPTIONS: ReadonlyArray<{ id: LLMProvider; name: string; hint: string }> = [
  { id: 'openai', name: 'OpenAI', hint: 'platform.openai.com' },
  { id: 'anthropic', name: 'Anthropic', hint: 'console.anthropic.com' },
  { id: 'openrouter', name: 'OpenRouter', hint: 'openrouter.ai/models — 400+ models from every lab' },
  { id: 'huggingface', name: 'Hugging Face', hint: 'huggingface.co/settings/tokens — open-weights models; add :fastest, :cheapest or :provider' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', hint: 'Ollama, LM Studio, vLLM, Groq, Together, DeepSeek… — set the base URL' },
];

/** A model choice shown in the picker. */
export interface LLMModelOption {
  id: string;
  name: string;
  /** Vendor group label, e.g. "OpenAI", "Anthropic". */
  group: string;
}

/**
 * Map a stored model ID to one the provider accepts.
 * The settings key is shared across providers, so a value saved for one provider
 * (e.g. "openai/gpt-4o" from OpenRouter) must not be sent to another.
 */
export function resolveLLMModel(provider: LLMProvider, stored: string | null | undefined): string {
  const model = (stored ?? '').trim();
  if (!model) return DEFAULT_LLM_MODELS[provider];

  switch (provider) {
    case 'openrouter':
    case 'custom':
      return model;
    case 'huggingface':
      // Hub IDs are always "org/model", optionally with a ":policy" or ":provider" suffix.
      return model.includes('/') ? model : DEFAULT_LLM_MODELS.huggingface;
    case 'openai': {
      const bare = model.startsWith('openai/') ? model.slice('openai/'.length) : model;
      if (bare.includes('/') || bare.startsWith('claude')) return DEFAULT_LLM_MODELS.openai;
      return bare;
    }
    case 'anthropic':
      return model.startsWith('claude-') ? model : DEFAULT_LLM_MODELS.anthropic;
  }
}

/**
 * Normalize and check a custom OpenAI-compatible base URL. Returns null when it's unusable.
 * SECURITY: the API key is sent to this URL, so plain http is only accepted for loopback and
 * private-network hosts (a local Ollama or LM Studio); anything public must be https.
 */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === 'https:') return trimmed;
  if (url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isPrivate = host === 'localhost' || host === '::1' || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return isPrivate ? trimmed : null;
}

/** Voice models offered in Settings, fastest first. */
export const TTS_MODEL_OPTIONS: ReadonlyArray<{ id: TTSModelId; name: string; note: string }> = [
  { id: 'eleven_v4_turbo', name: 'Eleven v4 Turbo', note: '~100ms, 90+ languages, starts speaking while the translation is still being written' },
  { id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', note: '~100ms, 32 languages, cheapest' },
  { id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', note: 'slower, 29 languages, previous default' },
];

/** Translation engines offered in Settings. `voice` says whose voice the meeting hears. */
export const TRANSLATION_ENGINE_OPTIONS: ReadonlyArray<{
  id: TranslationEngineId; name: string; voice: string; note: string;
}> = [
  {
    id: 'cascade', name: 'ElevenLabs Scribe → LLM → ElevenLabs voice (default)', voice: 'your ElevenLabs clone',
    note: 'Pick any LLM above. Speaks about a second after you stop talking.',
  },
  {
    id: 'qwen-livetranslate', name: 'Qwen3.8 LiveTranslate', voice: 'a clone Qwen makes from your first seconds of speech',
    note: 'Translates while you talk (~2 s behind). Understands 60 languages, speaks 29. Audio is processed by Alibaba Cloud.',
  },
  {
    id: 'openai-realtime-translate', name: 'OpenAI GPT-Realtime-Translate', voice: "OpenAI's voice, not your clone",
    note: 'Translates while you talk. 70+ input languages, 13 output languages. Audio is processed by OpenAI.',
  },
  {
    id: 'gemini-live-translate', name: 'Gemini 3.5 Live Translate (preview)', voice: 'keeps your intonation and pitch, not a clone',
    note: 'Translates while you talk. 70+ languages. Audio is processed by Google.',
  },
];
