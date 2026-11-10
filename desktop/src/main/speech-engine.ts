/**
 * Contract for speech-to-speech translation engines.
 *
 * The default "cascade" pipeline (Scribe → LLM → ElevenLabs) lives in desktop-pipeline.ts.
 * Engines implementing this interface replace all three stages with one model:
 * mic PCM goes in, translated PCM and transcripts come out.
 */

import type { ServiceConnectionState, TranslationEngineId } from '../shared/types.js';

/** Callbacks an engine uses to report results back to the pipeline. */
export interface SpeechEngineEvents {
  /** Incremental source-language transcript text. Append in arrival order. */
  onSourceText: (delta: string) => void;
  /** A source segment finished. `text` is the full segment transcript. */
  onSourceFinal: (text: string) => void;
  /** Incremental translated text. Append in arrival order. */
  onTranslationText: (delta: string) => void;
  /** A translated segment finished. `text` is the full segment translation. */
  onTranslationFinal: (text: string) => void;
  /** Translated speech: raw PCM s16le mono at `sampleRate`. */
  onAudio: (pcm: Buffer, sampleRate: number) => void;
  /** All audio for the current segment has been delivered. */
  onAudioDone: () => void;
  /** Connection state for the UI's service indicator. */
  onStateChange: (state: ServiceConnectionState) => void;
  /** Diagnostics for the debug log. Never include API keys. */
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface SpeechEngineStartOptions {
  /** 'auto' or a language code. Engines that only auto-detect may ignore it. */
  sourceLanguage: string;
  /** Target language code. */
  targetLanguage: string;
}

/** A speech-to-speech translation engine. One instance per session. */
export interface SpeechTranslationEngine {
  readonly id: Exclude<TranslationEngineId, 'cascade'>;
  /** Open the connection and configure the session. Resolves once audio can be sent. */
  start(options: SpeechEngineStartOptions): Promise<void>;
  /** Append 16 kHz PCM s16le mono mic audio. Safe to call before start() resolves. */
  sendAudio(pcm: Int16Array): void;
  /** The user stopped talking (push-to-talk released). Flush the pending segment. */
  endUtterance(): void;
  /** Finish gracefully: deliver remaining output, then close. */
  stop(): Promise<void>;
  /** Close immediately and drop pending output (panic stop). */
  abort(): void;
}
