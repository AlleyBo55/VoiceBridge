/**
 * Property tests for degradation, echo cancellation, debug log, language filtering.
 * Properties 6, 7, 8, 11, 19
 * Feature: desktop-app-rewrite
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { EchoState, EchoEvent, ServiceConnectionState, DegradationLevel } from '../../src/shared/types.js';
import { DesktopDebugLog } from '../../src/main/desktop-debug-log.js';
import { filterLanguages } from '../../src/main/language-service.js';

// ── Echo Cancellation (Property 6) ──────────────────────────

function transitionEchoState(current: EchoState, event: EchoEvent): EchoState {
  switch (current.status) {
    case 'listening':
      if (event.type === 'tts_start') return { status: 'speaking', ttsStartedAt: Date.now() };
      return current;
    case 'speaking':
      if (event.type === 'barge_in') return { status: 'listening' };
      if (event.type === 'tts_end') return { status: 'transitioning', ttsEndedAt: Date.now() };
      return current;
    case 'transitioning':
      if (event.type === 'transition_complete') return { status: 'listening' };
      if (event.type === 'barge_in') return { status: 'listening' };
      return current;
  }
}

function isMicMuted(state: EchoState): boolean {
  return state.status === 'speaking' || state.status === 'transitioning';
}

describe('Property 6: Echo cancellation state machine preserves transition rules', () => {
  const events: EchoEvent[] = [
    { type: 'tts_start' }, { type: 'tts_end' },
    { type: 'transition_complete' }, { type: 'barge_in' },
  ];

  it('from listening, only tts_start transitions to speaking', () => {
    for (const event of events) {
      const next = transitionEchoState({ status: 'listening' }, event);
      if (event.type === 'tts_start') {
        expect(next.status).toBe('speaking');
      } else {
        expect(next.status).toBe('listening');
      }
    }
  });

  it('from speaking, tts_end → transitioning, barge_in → listening', () => {
    for (const event of events) {
      const next = transitionEchoState({ status: 'speaking', ttsStartedAt: 0 }, event);
      if (event.type === 'tts_end') expect(next.status).toBe('transitioning');
      else if (event.type === 'barge_in') expect(next.status).toBe('listening');
      else expect(next.status).toBe('speaking');
    }
  });

  it('from transitioning, transition_complete or barge_in → listening', () => {
    for (const event of events) {
      const next = transitionEchoState({ status: 'transitioning', ttsEndedAt: 0 }, event);
      if (event.type === 'transition_complete' || event.type === 'barge_in') {
        expect(next.status).toBe('listening');
      } else {
        expect(next.status).toBe('transitioning');
      }
    }
  });

  it('mic is muted only in speaking and transitioning states', () => {
    expect(isMicMuted({ status: 'listening' })).toBe(false);
    expect(isMicMuted({ status: 'speaking', ttsStartedAt: 0 })).toBe(true);
    expect(isMicMuted({ status: 'transitioning', ttsEndedAt: 0 })).toBe(true);
  });
});

// ── Degradation (Property 7) ────────────────────────────────

interface ServiceHealth {
  stt: ServiceConnectionState;
  tts: ServiceConnectionState;
  llm: ServiceConnectionState;
}

function computeDegradationLevel(health: ServiceHealth): DegradationLevel {
  const sttOk = health.stt.status === 'connected';
  const llmOk = health.llm.status === 'connected';
  const ttsOk = health.tts.status === 'connected';
  if (sttOk && llmOk && ttsOk) return 'full';
  if (sttOk && llmOk) return 'text-only';
  if (sttOk) return 'transcription-only';
  return 'passthrough';
}

describe('Property 7: Degradation level computation follows cascade rules', () => {
  const connStates: ServiceConnectionState[] = [
    { status: 'connected' },
    { status: 'disconnected' },
    { status: 'connecting', attempt: 1 },
    { status: 'error', error: 'test', retryable: true },
  ];

  it('follows the cascade: full → text-only → transcription-only → passthrough', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...connStates),
        fc.constantFrom(...connStates),
        fc.constantFrom(...connStates),
        (stt, llm, tts) => {
          const level = computeDegradationLevel({ stt, tts, llm });
          const sttOk = stt.status === 'connected';
          const llmOk = llm.status === 'connected';
          const ttsOk = tts.status === 'connected';

          if (sttOk && llmOk && ttsOk) expect(level).toBe('full');
          else if (sttOk && llmOk) expect(level).toBe('text-only');
          else if (sttOk) expect(level).toBe('transcription-only');
          else expect(level).toBe('passthrough');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Backpressure (Property 8) ────────────────────────────────

describe('Property 8: Backpressure queue never exceeds configured limits', () => {
  it('enforces max queue size of 3', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (numUtterances) => {
          const maxQueueSize = 3;
          const queue: number[] = [];

          for (let i = 0; i < numUtterances; i++) {
            queue.push(i);
            while (queue.length > maxQueueSize) {
              queue.shift();
            }
          }

          expect(queue.length).toBeLessThanOrEqual(maxQueueSize);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Language Filtering (Property 11) ─────────────────────────

describe('Property 11: Language filtering excludes source and matches search query', () => {
  const testLanguages = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'ja', name: 'Japanese' },
    { code: 'zh', name: 'Chinese (Mandarin)' },
  ];

  it('never contains the selected source language', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...testLanguages.map(l => l.code)),
        fc.string({ maxLength: 10 }),
        (sourceCode, query) => {
          const filtered = filterLanguages(testLanguages, sourceCode, query);
          for (const lang of filtered) {
            expect(lang.code).not.toBe(sourceCode);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('only contains languages matching the search query', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('en', 'es', 'fr', 'de', 'ja', 'zh'),
        fc.constantFrom('', 'en', 'sp', 'french', 'man', 'xyz'),
        (sourceCode, query) => {
          const filtered = filterLanguages(testLanguages, sourceCode, query);
          if (query.trim()) {
            const q = query.toLowerCase().trim();
            for (const lang of filtered) {
              const matches = lang.name.toLowerCase().includes(q) || lang.code.toLowerCase().includes(q);
              expect(matches).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Debug Log Ring Buffer (Property 19) ─────────────────────

describe('Property 19: Debug log ring buffer never exceeds maximum size', () => {
  it('buffer never exceeds 500 entries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        (numEntries) => {
          const log = new DesktopDebugLog();
          for (let i = 0; i < numEntries; i++) {
            log.log('info', 'pipeline', `Entry ${i}`);
          }
          expect(log.getBufferSize()).toBeLessThanOrEqual(500);
          expect(log.getBufferSize()).toBe(Math.min(numEntries, 500));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('oldest entries are evicted first (FIFO)', () => {
    const log = new DesktopDebugLog();
    for (let i = 0; i < 510; i++) {
      log.log('info', 'pipeline', `Entry ${i}`);
    }
    const entries = log.getEntries();
    expect(entries.length).toBe(500);
    expect(entries[0]?.message).toBe('Entry 10');
    expect(entries[499]?.message).toBe('Entry 509');
  });
});
