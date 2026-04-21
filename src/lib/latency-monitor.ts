/**
 * Per-stage and end-to-end latency tracking for each utterance.
 */

import type { LatencyMeasurement } from './types.js';

// ── Constants ───────────────────────────────────────────────

const MAX_HISTORY = 100;

// ── Timing Marks ────────────────────────────────────────────

interface TimingMarks {
  captureStart?: number;
  captureEnd?: number;
  sttEnd?: number;
  translationStart?: number;
  translationFirstToken?: number;
  ttsFirstByte?: number;
  playbackStart?: number;
}

// ── Latency Monitor ─────────────────────────────────────────

export class LatencyMonitor {
  #marks = new Map<number, TimingMarks>();
  #history: LatencyMeasurement[] = [];

  onLatencyUpdate: ((measurement: LatencyMeasurement) => void) | null = null;

  markCaptureStart(sequenceId: number): void {
    this.#getOrCreate(sequenceId).captureStart = Date.now();
  }

  markCaptureEnd(sequenceId: number): void {
    this.#getOrCreate(sequenceId).captureEnd = Date.now();
  }

  markSTTEnd(sequenceId: number): void {
    this.#getOrCreate(sequenceId).sttEnd = Date.now();
  }

  markTranslationStart(sequenceId: number): void {
    this.#getOrCreate(sequenceId).translationStart = Date.now();
  }

  markTranslationFirstToken(sequenceId: number): void {
    this.#getOrCreate(sequenceId).translationFirstToken = Date.now();
  }

  markTTSFirstByte(sequenceId: number): void {
    this.#getOrCreate(sequenceId).ttsFirstByte = Date.now();
  }

  markPlaybackStart(sequenceId: number): void {
    const marks = this.#getOrCreate(sequenceId);
    marks.playbackStart = Date.now();
    this.#finalize(sequenceId, marks);
  }

  getMeasurement(sequenceId: number): LatencyMeasurement | undefined {
    return this.#history.find(m => m.sequenceId === sequenceId);
  }

  /**
   * Get average latency over the last N measurements.
   */
  getAverageLatency(windowSize: number = 10): LatencyMeasurement {
    const recent = this.#history.slice(-windowSize);
    if (recent.length === 0) {
      return { sequenceId: 0, captureMs: 0, sttMs: 0, translationMs: 0, ttsMs: 0, routingMs: 0, totalMs: 0, timestamp: Date.now() };
    }

    const avg = (key: keyof LatencyMeasurement) =>
      recent.reduce((sum, m) => sum + (m[key] as number), 0) / recent.length;

    return {
      sequenceId: 0,
      captureMs: Math.round(avg('captureMs')),
      sttMs: Math.round(avg('sttMs')),
      translationMs: Math.round(avg('translationMs')),
      ttsMs: Math.round(avg('ttsMs')),
      routingMs: Math.round(avg('routingMs')),
      totalMs: Math.round(avg('totalMs')),
      timestamp: Date.now(),
    };
  }

  getLatencyHistory(): LatencyMeasurement[] {
    return [...this.#history];
  }

  clear(): void {
    this.#marks.clear();
    this.#history = [];
  }

  #getOrCreate(sequenceId: number): TimingMarks {
    let marks = this.#marks.get(sequenceId);
    if (!marks) {
      marks = {};
      this.#marks.set(sequenceId, marks);
    }
    return marks;
  }

  #finalize(sequenceId: number, marks: TimingMarks): void {
    const captureMs = (marks.captureEnd ?? 0) - (marks.captureStart ?? 0);
    const sttMs = (marks.sttEnd ?? 0) - (marks.captureEnd ?? 0);
    const translationMs = (marks.translationFirstToken ?? 0) - (marks.translationStart ?? marks.sttEnd ?? 0);
    const ttsMs = (marks.ttsFirstByte ?? 0) - (marks.translationFirstToken ?? 0);
    const routingMs = (marks.playbackStart ?? 0) - (marks.ttsFirstByte ?? 0);
    const totalMs = (marks.playbackStart ?? 0) - (marks.captureStart ?? 0);

    const measurement: LatencyMeasurement = {
      sequenceId,
      captureMs: Math.max(0, captureMs),
      sttMs: Math.max(0, sttMs),
      translationMs: Math.max(0, translationMs),
      ttsMs: Math.max(0, ttsMs),
      routingMs: Math.max(0, routingMs),
      totalMs: Math.max(0, totalMs),
      timestamp: Date.now(),
    };

    this.#history.push(measurement);
    while (this.#history.length > MAX_HISTORY) {
      this.#history.shift();
    }

    // Clean up marks
    this.#marks.delete(sequenceId);

    this.onLatencyUpdate?.(measurement);
  }
}
