/**
 * LLM-based translation engine with streaming, context window, and buffering.
 * Supports OpenAI and Anthropic providers.
 */

import type { LLMProvider, GlossaryEntry } from './types.js';
import type { STTTranscript } from './stt-client.js';

// ── Constants ───────────────────────────────────────────────

const SHORT_UTTERANCE_WORDS = 3;
const SHORT_UTTERANCE_BUFFER_MS = 1500;
const TRANSLATION_TIMEOUT_MS = 5000;
const MAX_LENGTH_RATIO = 3;

// ── Configuration ───────────────────────────────────────────

export interface TranslationConfig {
  provider: LLMProvider;
  apiKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  contextWindowSize: number;
  preserveTechnicalTerms: boolean;
  customGlossary: GlossaryEntry[];
  meetingContext: string;
  formalityLevel: 'formal' | 'informal';
  shortUtteranceBufferMs: number;
}

const DEFAULT_CONFIG: TranslationConfig = {
  provider: 'openai',
  apiKey: '',
  sourceLanguage: 'auto',
  targetLanguage: 'es',
  contextWindowSize: 10,
  preserveTechnicalTerms: true,
  customGlossary: [],
  meetingContext: '',
  formalityLevel: 'informal',
  shortUtteranceBufferMs: SHORT_UTTERANCE_BUFFER_MS,
};

// ── Preservation Markers ────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s]+/g;
const EMAIL_REGEX = /[\w.-]+@[\w.-]+\.\w+/g;
const CODE_REGEX = /`[^`]+`/g;
const NUMBER_REGEX = /\b\d+([.,]\d+)*\b/g;

/**
 * Wrap preservable tokens (URLs, emails, code, numbers) with markers.
 */
export function addPreservationMarkers(text: string): { markedText: string; markers: Map<string, string> } {
  const markers = new Map<string, string>();
  let counter = 0;
  let markedText = text;

  const patterns = [URL_REGEX, EMAIL_REGEX, CODE_REGEX, NUMBER_REGEX];
  for (const pattern of patterns) {
    markedText = markedText.replace(pattern, (match) => {
      const key = `__PRESERVE_${counter++}__`;
      markers.set(key, match);
      return key;
    });
  }

  return { markedText, markers };
}

/**
 * Restore preserved tokens from markers.
 */
export function removePreservationMarkers(text: string, markers: Map<string, string>): string {
  let result = text;
  for (const [key, value] of markers) {
    result = result.replace(key, value);
  }
  return result;
}

// ── Context Window ──────────────────────────────────────────

/**
 * Sliding context window for conversational coherence.
 */
export class ContextWindow {
  #entries: Array<{ source: string; translated: string }> = [];
  #maxSize: number;

  constructor(maxSize: number = 10) {
    this.#maxSize = maxSize;
  }

  add(source: string, translated: string): void {
    this.#entries.push({ source, translated });
    while (this.#entries.length > this.#maxSize) {
      this.#entries.shift();
    }
  }

  getEntries(): Array<{ source: string; translated: string }> {
    return [...this.#entries];
  }

  setMaxSize(size: number): void {
    this.#maxSize = size;
    while (this.#entries.length > this.#maxSize) {
      this.#entries.shift();
    }
  }

  clear(): void {
    this.#entries = [];
  }
}

// ── Sentence Splitting ──────────────────────────────────────

const CLAUSE_BOUNDARY_REGEX = /[,;]\s+|\s+(?:and|or|but|because|although|however|therefore|meanwhile)\s+/i;

/**
 * Split long sentences (>50 words) at natural clause boundaries.
 */
export function splitLongSentence(text: string, maxWords: number = 50): string[] {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return [text];

  const segments: string[] = [];
  const parts = text.split(CLAUSE_BOUNDARY_REGEX);

  let current = '';
  for (const part of parts) {
    const combined = current ? `${current}, ${part}` : part;
    if (combined.split(/\s+/).length > maxWords && current) {
      segments.push(current.trim());
      current = part;
    } else {
      current = combined;
    }
  }
  if (current.trim()) segments.push(current.trim());

  return segments.length > 0 ? segments : [text];
}

// ── System Prompt ───────────────────────────────────────────

function buildSystemPrompt(config: TranslationConfig, context: Array<{ source: string; translated: string }>): string {
  let prompt = `You are a real-time speech translator. Translate the following text from ${config.sourceLanguage} to ${config.targetLanguage}.

Rules:
- Translate naturally, not literally. Preserve tone, intent, and emotion.
- Handle idioms appropriately for the target language.
- Output ONLY the translated text. No explanations, no notes, no brackets.
- Preserve proper nouns, brand names, and technical acronyms without translation.
- Keep the translation concise — match the source length where possible.`;

  if (config.formalityLevel === 'formal') {
    prompt += '\n- Use formal register and honorifics appropriate for the target language.';
  } else {
    prompt += '\n- Use casual, conversational register.';
  }

  if (config.preserveTechnicalTerms) {
    prompt += '\n- Preserve technical terminology in its original form when no standard translation exists.';
  }

  if (config.meetingContext) {
    prompt += `\n- Meeting context: ${config.meetingContext}`;
  }

  if (config.customGlossary.length > 0) {
    prompt += '\n\nMandatory terminology mappings (always use these translations):';
    for (const entry of config.customGlossary) {
      prompt += `\n- "${entry.source}" → "${entry.target}"`;
    }
  }

  if (context.length > 0) {
    prompt += '\n\nRecent conversation context (for coherence):';
    for (const entry of context) {
      prompt += `\n[${config.sourceLanguage}]: ${entry.source}`;
      prompt += `\n[${config.targetLanguage}]: ${entry.translated}`;
    }
  }

  return prompt;
}

// ── Translation Engine ──────────────────────────────────────

export class TranslationEngine {
  #config: TranslationConfig;
  #contextWindow: ContextWindow;
  #shortUtteranceBuffer: { text: string; sequenceId: number; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(config: Partial<TranslationConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#contextWindow = new ContextWindow(this.#config.contextWindowSize);
  }

  setConfig(config: Partial<TranslationConfig>): void {
    Object.assign(this.#config, config);
    this.#contextWindow.setMaxSize(this.#config.contextWindowSize);
  }

  setLanguagePair(source: string, target: string): void {
    this.#config.sourceLanguage = source;
    this.#config.targetLanguage = target;
  }

  getContextWindow(): Array<{ source: string; translated: string }> {
    return this.#contextWindow.getEntries();
  }

  /**
   * Translate a transcript segment. Yields tokens as they arrive from the LLM.
   */
  async *translate(transcript: STTTranscript): AsyncGenerator<string> {
    const text = transcript.text.trim();
    if (!text) return;

    // Short utterance buffering: wait for more input if < 3 words
    const wordCount = text.split(/\s+/).length;
    if (wordCount < SHORT_UTTERANCE_WORDS) {
      const buffered = await this.#bufferShortUtterance(text, transcript.sequenceId);
      if (!buffered) return;
      yield* this.#performTranslation(buffered);
      return;
    }

    yield* this.#performTranslation(text);
  }

  async *#performTranslation(text: string): AsyncGenerator<string> {
    // Apply preservation markers
    const { markedText, markers } = addPreservationMarkers(text);

    const systemPrompt = buildSystemPrompt(this.#config, this.#contextWindow.getEntries());

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
      const tokens: string[] = [];

      if (this.#config.provider === 'openai') {
        yield* this.#streamOpenAI(systemPrompt, markedText, controller.signal, tokens);
      } else {
        yield* this.#streamAnthropic(systemPrompt, markedText, controller.signal, tokens);
      }

      const fullTranslation = removePreservationMarkers(tokens.join(''), markers);

      // Length guard: flag if translation > 3x source length
      if (fullTranslation.length > text.length * MAX_LENGTH_RATIO) {
        console.warn('[Translation] Output exceeds 3x source length, may be erroneous');
      }

      this.#contextWindow.add(text, fullTranslation);
    } finally {
      clearTimeout(timeout);
    }
  }

  async *#streamOpenAI(
    systemPrompt: string,
    text: string,
    signal: AbortSignal,
    tokens: string[]
  ): AsyncGenerator<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#config.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        stream: true,
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            tokens.push(token);
            yield token;
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async *#streamAnthropic(
    systemPrompt: string,
    text: string,
    signal: AbortSignal,
    tokens: string[]
  ): AsyncGenerator<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.#config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        system: systemPrompt,
        messages: [{ role: 'user', content: text }],
        stream: true,
        max_tokens: 1000,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6)) as { type?: string; delta?: { text?: string } };
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            tokens.push(parsed.delta.text);
            yield parsed.delta.text;
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  #bufferShortUtterance(text: string, sequenceId: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.#shortUtteranceBuffer) {
        // Combine with existing buffer
        const combined = `${this.#shortUtteranceBuffer.text} ${text}`;
        clearTimeout(this.#shortUtteranceBuffer.timer);
        this.#shortUtteranceBuffer = null;
        resolve(combined);
        return;
      }

      // Start buffer timer
      const timer = setTimeout(() => {
        const buffered = this.#shortUtteranceBuffer;
        this.#shortUtteranceBuffer = null;
        resolve(buffered?.text ?? null);
      }, this.#config.shortUtteranceBufferMs);

      this.#shortUtteranceBuffer = { text, sequenceId, timer };
    });
  }

  destroy(): void {
    if (this.#shortUtteranceBuffer) {
      clearTimeout(this.#shortUtteranceBuffer.timer);
      this.#shortUtteranceBuffer = null;
    }
    this.#contextWindow.clear();
  }
}
