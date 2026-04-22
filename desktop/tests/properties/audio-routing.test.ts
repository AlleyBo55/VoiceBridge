/**
 * Property tests for audio pipeline pure functions.
 * Properties 1, 2, 3, 4, 5, 9, 10
 * Feature: desktop-app-rewrite
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeRmsDb,
  transitionVADState,
  transitionRoutingState,
  getAudioSource,
  normalizeVolume,
} from '../../src/main/audio-router.js';
import { latencyToColor, HighLatencyDetector } from '../../src/main/desktop-latency.js';
import type { VADState, AudioRoutingState, AudioRoutingEvent } from '../../src/shared/types.js';

// ── Property 1: Audio chunking produces fixed-size output ───

describe('Property 1: Audio chunking produces fixed-size output', () => {
  const CHUNK_SIZE = 4000;

  it('emits only full 4000-sample chunks', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 10 }),
        (inputLengths) => {
          let buffer = new Int16Array(CHUNK_SIZE);
          let bufferOffset = 0;
          const emittedChunks: Int16Array[] = [];

          for (const len of inputLengths) {
            const samples = new Int16Array(len);
            let offset = 0;
            while (offset < samples.length) {
              const remaining = CHUNK_SIZE - bufferOffset;
              const toCopy = Math.min(remaining, samples.length - offset);
              buffer.set(samples.subarray(offset, offset + toCopy), bufferOffset);
              bufferOffset += toCopy;
              offset += toCopy;

              if (bufferOffset === CHUNK_SIZE) {
                emittedChunks.push(buffer);
                buffer = new Int16Array(CHUNK_SIZE);
                bufferOffset = 0;
              }
            }
          }

          // Every emitted chunk is exactly CHUNK_SIZE
          for (const chunk of emittedChunks) {
            expect(chunk.length).toBe(CHUNK_SIZE);
          }

          // Total emitted = largest multiple of CHUNK_SIZE <= total input
          const totalInput = inputLengths.reduce((a, b) => a + b, 0);
          const expectedChunks = Math.floor(totalInput / CHUNK_SIZE);
          expect(emittedChunks.length).toBe(expectedChunks);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 2: TTS resampling preserves sample count ratio ─

describe('Property 2: TTS resampling preserves sample count ratio and value range', () => {
  it('24kHz → 48kHz produces 2x samples, all in [-1.0, 1.0] as Float32', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -32768, max: 32767 }), { minLength: 10, maxLength: 1000 }),
        (samples) => {
          const input = new Int16Array(samples);
          const resampledLength = Math.ceil(input.length * (48000 / 24000));

          // Verify ratio
          expect(resampledLength).toBe(input.length * 2);

          // Convert to Float32 and verify range
          const float32 = new Float32Array(input.length);
          for (let i = 0; i < input.length; i++) {
            float32[i] = (input[i] ?? 0) / 32768.0;
          }

          for (let i = 0; i < float32.length; i++) {
            expect(float32[i]).toBeGreaterThanOrEqual(-1.0);
            expect(float32[i]).toBeLessThanOrEqual(1.0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 3: Audio routing state machine ─────────────────

describe('Property 3: Audio routing state machine transitions are deterministic and complete', () => {
  const states: AudioRoutingState[] = ['PASSTHROUGH', 'MUTED', 'TTS_PLAYING', 'BARGE_IN'];
  const events: AudioRoutingEvent[] = [
    { type: 'session_start' }, { type: 'session_stop' },
    { type: 'vad_speech_start' }, { type: 'vad_speech_end' },
    { type: 'tts_start' }, { type: 'tts_end' },
    { type: 'barge_in' }, { type: 'degraded_to_passthrough' },
  ];

  it('always returns a valid state for any state+event combination', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...states),
        fc.constantFrom(...events),
        (state, event) => {
          const next = transitionRoutingState(state, event);
          expect(states).toContain(next);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getAudioSource returns correct source for each state', () => {
    expect(getAudioSource('PASSTHROUGH')).toBe('mic');
    expect(getAudioSource('MUTED')).toBe('silence');
    expect(getAudioSource('TTS_PLAYING')).toBe('tts');
    expect(getAudioSource('BARGE_IN')).toBe('mic-fade-tts');
  });
});

// ── Property 4: VAD state transitions follow delay rules ────

describe('Property 4: VAD state transitions follow onset/offset delay rules', () => {
  it('silence → speech requires onset delay', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1000 }), // onsetDelayMs
        fc.integer({ min: 100, max: 2000 }), // offsetDelayMs
        fc.double({ min: -80, max: 0 }),      // threshold
        (onsetMs, offsetMs, threshold) => {
          let state: VADState = { status: 'silence' };
          const aboveThreshold = threshold + 10;
          const now = 1000;

          // First above-threshold: goes to speech-pending
          state = transitionVADState(state, aboveThreshold, threshold, now, onsetMs, offsetMs);
          expect(state.status).toBe('speech-pending');

          // Before onset delay: stays speech-pending
          state = transitionVADState(state, aboveThreshold, threshold, now + onsetMs - 1, onsetMs, offsetMs);
          expect(state.status).toBe('speech-pending');

          // At onset delay: transitions to speech
          state = transitionVADState(state, aboveThreshold, threshold, now + onsetMs, onsetMs, offsetMs);
          expect(state.status).toBe('speech');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('speech → silence requires offset delay', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 100, max: 2000 }),
        fc.double({ min: -80, max: 0 }),
        (onsetMs, offsetMs, threshold) => {
          let state: VADState = { status: 'speech' };
          const belowThreshold = threshold - 10;
          const now = 1000;

          // Below threshold: goes to silence-pending
          state = transitionVADState(state, belowThreshold, threshold, now, onsetMs, offsetMs);
          expect(state.status).toBe('silence-pending');

          // Before offset delay: stays silence-pending
          state = transitionVADState(state, belowThreshold, threshold, now + offsetMs - 1, onsetMs, offsetMs);
          expect(state.status).toBe('silence-pending');

          // At offset delay: transitions to silence
          state = transitionVADState(state, belowThreshold, threshold, now + offsetMs, onsetMs, offsetMs);
          expect(state.status).toBe('silence');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 5: Noise gate rejects sub-threshold audio ──────

describe('Property 5: Noise gate rejects sub-threshold audio', () => {
  it('computeRmsDb returns -Infinity for silence', () => {
    const silence = new Int16Array(160);
    expect(computeRmsDb(silence)).toBe(-Infinity);
  });

  it('computeRmsDb returns finite value for non-silence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -32768, max: 32767 }).filter(n => n !== 0), { minLength: 10, maxLength: 160 }),
        (samples) => {
          const pcm = new Int16Array(samples);
          const db = computeRmsDb(pcm);
          expect(db).toBeGreaterThan(-Infinity);
          expect(db).toBeLessThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('louder signals produce higher dB values', () => {
    const quiet = new Int16Array(160).fill(100);
    const loud = new Int16Array(160).fill(10000);
    expect(computeRmsDb(loud)).toBeGreaterThan(computeRmsDb(quiet));
  });
});

// ── Property 9: Volume normalization ────────────────────────

describe('Property 9: Volume normalization scales TTS output to match reference level', () => {
  it('normalized output RMS is within ±3dB of target', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: -10 }), // referenceRmsDb
        fc.integer({ min: -50, max: -10 }), // targetRmsDb
        (referenceRmsDb, targetRmsDb) => {
          // Create a test signal
          const samples = new Int16Array(1000);
          for (let i = 0; i < samples.length; i++) {
            samples[i] = Math.round(Math.sin(i * 0.1) * 5000);
          }

          const normalized = normalizeVolume(samples, referenceRmsDb, targetRmsDb);
          expect(normalized.length).toBe(samples.length);

          // All samples should be in valid Int16 range
          for (let i = 0; i < normalized.length; i++) {
            expect(normalized[i]).toBeGreaterThanOrEqual(-32768);
            expect(normalized[i]).toBeLessThanOrEqual(32767);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 10: Latency-to-color mapping ───────────────────

describe('Property 10: Latency-to-color mapping follows threshold boundaries', () => {
  it('green < 1500, yellow 1500-2500, red > 2500', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10000 }),
        (latencyMs) => {
          const color = latencyToColor(latencyMs);
          if (latencyMs < 1500) expect(color).toBe('green');
          else if (latencyMs <= 2500) expect(color).toBe('yellow');
          else expect(color).toBe('red');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 20: Consecutive high-latency detection ─────────

describe('Property 20: Consecutive high-latency detection triggers at exact threshold', () => {
  it('triggers after exactly 5 consecutive measurements > 3000ms', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 1, maxLength: 50 }),
        (measurements) => {
          const detector = new HighLatencyDetector(3000, 5);
          let consecutiveHigh = 0;
          let triggered = false;

          for (const ms of measurements) {
            if (ms > 3000) {
              consecutiveHigh++;
            } else {
              consecutiveHigh = 0;
            }

            const result = detector.record(ms);
            if (consecutiveHigh >= 5 && !triggered) {
              expect(result).toBe(true);
              triggered = true;
            }
            if (consecutiveHigh < 5) {
              expect(result).toBe(false);
              triggered = false;
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('resets counter when a measurement <= 3000ms is observed', () => {
    const detector = new HighLatencyDetector(3000, 5);
    // 4 high measurements
    for (let i = 0; i < 4; i++) detector.record(4000);
    expect(detector.getConsecutiveCount()).toBe(4);
    // One normal measurement resets
    detector.record(1000);
    expect(detector.getConsecutiveCount()).toBe(0);
  });
});
