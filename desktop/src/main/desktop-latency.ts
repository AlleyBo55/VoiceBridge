/**
 * Desktop latency monitor with color mapping and high-latency detection.
 * Reuses the core LatencyMonitor logic, adds Electron IPC emission.
 */

import type { BrowserWindow } from 'electron';
import type { LatencyMeasurement } from '../shared/types.js';
import { sendToRenderer } from './electron-ipc.js';

// ── Constants ───────────────────────────────────────────────

const MAX_HISTORY = 100;
const HIGH_LATENCY_THRESHOLD_MS = 3000;
const HIGH_LATENCY_CONSECUTIVE_COUNT = 5;

// ── Latency Color Mapping ───────────────────────────────────

export type LatencyColor = 'green' | 'yellow' | 'red';

/**
 * Map latency to color based on threshold boundaries.
 * green: < 1500ms, yellow: 1500-2500ms, red: > 2500ms
 */
export function latencyToColor(latencyMs: number): LatencyColor {
  if (latencyMs < 1500) return 'green';
  if (latencyMs <= 2500) return 'yellow';
  return 'red';
}

// ── Consecutive High Latency Detector ───────────────────────

export class HighLatencyDetector {
  #consecutiveCount = 0;
  #threshold: number;
  #triggerCount: number;

  constructor(threshold: number = HIGH_LATENCY_THRESHOLD_MS, triggerCount: number = HIGH_LATENCY_CONSECUTIVE_COUNT) {
    this.#threshold = threshold;
    this.#triggerCount = triggerCount;
  }

  /**
   * Record a latency measurement. Returns true if warning should be emitted.
   */
  record(latencyMs: number): boolean {
    if (latencyMs > this.#threshold) {
      this.#consecutiveCount++;
      return this.#consecutiveCount >= this.#triggerCount;
    }
    this.#consecutiveCount = 0;
    return false;
  }

  getConsecutiveCount(): number {
    return this.#consecutiveCount;
  }

  reset(): void {
    this.#consecutiveCount = 0;
  }
}

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

// ── Desktop Latency Monitor ─────────────────────────────────

export class DesktopLatencyMonitor {
  #marks = new Map<number, TimingMarks>();
  #history: LatencyMeasurement[] = [];
  #highLatencyDetector = new HighLatencyDetector();
  #mainWindow: BrowserWindow | null;

  constructor(mainWindow: BrowserWindow | null) {
    this.#mainWindow = mainWindow;
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.#mainWindow = window;
  }

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

  clear(): void {
    this.#marks.clear();
    this.#history = [];
    this.#highLatencyDetector.reset();
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
    this.#marks.delete(sequenceId);

    // Emit to renderer
    sendToRenderer(this.#mainWindow, 'pipeline:latency-update', measurement);

    // Check for high latency
    if (this.#highLatencyDetector.record(measurement.totalMs)) {
      sendToRenderer(this.#mainWindow, 'error', {
        code: 'high-latency',
        message: `${this.#highLatencyDetector.getConsecutiveCount()} consecutive high-latency utterances`,
        userMessage: 'Translation latency is high. Check your network or reduce quality settings.',
      });
    }
  }
}
