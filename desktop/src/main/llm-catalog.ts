/**
 * Live model lists and API key checks for every translation provider.
 *
 * Why live lists: new models ship every few weeks. A hardcoded picker goes stale (the old one
 * still offered retired IDs), while each provider's own /models endpoint is always current.
 */

import type { LLMProvider } from '../shared/types.js';
import { LLM_BASE_URLS, normalizeBaseUrl, type LLMModelOption } from '../shared/llm-models.js';

const TIMEOUT_MS = 10_000;

/** OpenAI models that can't serve a streamed chat translation (audio, images, realtime, Responses-only). */
const OPENAI_NON_CHAT = /realtime|audio|transcribe|tts|image|embedding|whisper|dall-e|moderation|search|live|translate|codex|instruct|computer-use|-pro\b/;

/** Display order of vendor groups; anything else follows alphabetically. */
const VENDOR_ORDER = ['OpenAI', 'Anthropic', 'Google', 'Qwen', 'DeepSeek', 'Meta', 'Mistral', 'xAI', 'Moonshot', 'Z.ai'];
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', qwen: 'Qwen', deepseek: 'DeepSeek',
  'deepseek-ai': 'DeepSeek', 'meta-llama': 'Meta', mistralai: 'Mistral', 'x-ai': 'xAI', moonshotai: 'Moonshot',
  'z-ai': 'Z.ai', 'zai-org': 'Z.ai', minimax: 'MiniMax', minimaxai: 'MiniMax', cohere: 'Cohere', coherelabs: 'Cohere',
  nvidia: 'NVIDIA', microsoft: 'Microsoft', amazon: 'Amazon', perplexity: 'Perplexity',
};

function vendorOf(id: string): string {
  const prefix = id.replace(/^~/, '').split('/')[0]?.toLowerCase() ?? '';
  return VENDOR_NAMES[prefix] ?? (prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : 'Other');
}

function vendorRank(group: string): number {
  const i = VENDOR_ORDER.indexOf(group);
  return i === -1 ? VENDOR_ORDER.length : i;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

function dataArray(json: unknown): Array<Record<string, unknown>> {
  const data = typeof json === 'object' && json !== null ? (json as Record<string, unknown>)['data'] : undefined;
  return Array.isArray(data) ? data.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>)['id'] === 'string') : [];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Sort by vendor priority, then newest first. */
function byVendorThenNewest(models: Array<LLMModelOption & { created: number }>): LLMModelOption[] {
  return models
    .sort((a, b) => vendorRank(a.group) - vendorRank(b.group) || a.group.localeCompare(b.group) || b.created - a.created)
    .map(({ id, name, group }) => ({ id, name, group }));
}

/**
 * Models the provider can stream a translation with, grouped by vendor.
 * Returns [] on any failure; the picker then offers the current value and the default.
 */
export async function listLLMModels(provider: LLMProvider, apiKey: string, baseUrl: string): Promise<LLMModelOption[]> {
  try {
    const bearer: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    switch (provider) {
      case 'openrouter': {
        const models = dataArray(await getJson(`${LLM_BASE_URLS.openrouter}/models`, bearer))
          .filter((m) => {
            const id = text(m['id']);
            const arch = m['architecture'] as Record<string, unknown> | undefined;
            const outputs = Array.isArray(arch?.['output_modalities']) ? arch['output_modalities'] as unknown[] : ['text'];
            return !id.endsWith(':batch') && outputs.includes('text');
          })
          .map((m) => {
            const id = text(m['id']);
            const name = text(m['name']).replace(/^[^:]+:\s*/, '') || id;
            return { id, name, group: vendorOf(id), created: num(m['created']) };
          });
        return byVendorThenNewest(models);
      }
      case 'openai': {
        const models = dataArray(await getJson(`${LLM_BASE_URLS.openai}/models`, bearer))
          .filter((m) => {
            const id = text(m['id']);
            return /^(gpt-|chatgpt-|o\d)/.test(id) && !OPENAI_NON_CHAT.test(id);
          })
          .map((m) => ({ id: text(m['id']), name: text(m['id']), group: 'OpenAI', created: num(m['created']) }));
        return byVendorThenNewest(models);
      }
      case 'anthropic': {
        const json = await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
        // Already newest first.
        return dataArray(json).map((m) => ({ id: text(m['id']), name: text(m['display_name']) || text(m['id']), group: 'Anthropic' }));
      }
      case 'huggingface': {
        // PERF: fastest first-token latency first, because that is what a live interpreter waits on.
        const models = dataArray(await getJson(`${LLM_BASE_URLS.huggingface}/models`, bearer))
          .map((m) => {
            const providers = Array.isArray(m['providers']) ? m['providers'] as Array<Record<string, unknown>> : [];
            const live = providers.filter((p) => p['status'] === 'live');
            const latencies = live.map((p) => num(p['first_token_latency_ms'])).filter((ms) => ms > 0);
            const best = latencies.length > 0 ? Math.min(...latencies) : Number.POSITIVE_INFINITY;
            const arch = m['architecture'] as Record<string, unknown> | undefined;
            const outputs = Array.isArray(arch?.['output_modalities']) ? arch['output_modalities'] as unknown[] : ['text'];
            return { m, best, ok: live.length > 0 && outputs.includes('text') };
          })
          .filter((x) => x.ok)
          .sort((a, b) => a.best - b.best)
          .map(({ m, best }) => {
            const id = text(m['id']);
            const latency = Number.isFinite(best) ? ` · ${Math.round(best)} ms first token` : '';
            return { id, name: `${id}${latency}`, group: text(m['owned_by']) || vendorOf(id) };
          });
        return models;
      }
      case 'custom': {
        const base = normalizeBaseUrl(baseUrl);
        if (!base) return [];
        return dataArray(await getJson(`${base}/models`, bearer)).map((m) => ({ id: text(m['id']), name: text(m['id']), group: 'Your server' }));
      }
    }
  } catch (err) {
    console.warn(`[models] ${provider} model list failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Check a key with a read-only, free request.
 * Note: OpenRouter's and Hugging Face's model lists are public, so they can't prove a key works;
 * their key-info endpoints can.
 */
export async function validateLLMKey(provider: LLMProvider, apiKey: string, baseUrl: string): Promise<{ valid: boolean; error?: string }> {
  let url: string;
  const headers: Record<string, string> = {};
  switch (provider) {
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/models?limit=1';
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'openrouter':
      url = 'https://openrouter.ai/api/v1/key';
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'huggingface':
      url = 'https://huggingface.co/api/whoami-v2';
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'openai':
      url = `${LLM_BASE_URLS.openai}/models`;
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'custom': {
      const base = normalizeBaseUrl(baseUrl);
      if (!base) return { valid: false, error: 'Base URL must be https, or http on localhost / a private network' };
      url = `${base}/models`;
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    }
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return { valid: true };
    if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
    return { valid: false, error: `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return { valid: false, error: provider === 'custom' ? `Server not reachable: ${message}` : message };
  }
}
