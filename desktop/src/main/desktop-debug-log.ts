/**
 * Desktop debug log with 500-entry ring buffer.
 * Reuses the DebugLogEntry type, increases buffer from 200 to 500.
 */

import type { DebugLogEntry } from '../shared/types.js';

// ── Constants ───────────────────────────────────────────────

const MAX_ENTRIES = 500;

// ── Desktop Debug Log ───────────────────────────────────────

export class DesktopDebugLog {
  #buffer: DebugLogEntry[] = [];

  /** Add a log entry to the circular buffer. */
  log(
    level: DebugLogEntry['level'],
    category: DebugLogEntry['category'],
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: DebugLogEntry = { timestamp: Date.now(), level, category, message };
    if (metadata) entry.metadata = metadata;

    this.#buffer.push(entry);
    while (this.#buffer.length > MAX_ENTRIES) {
      this.#buffer.shift();
    }

    // Console output in development
    const prefix = `[VB:${category}]`;
    switch (level) {
      case 'info': console.log(prefix, message, metadata ?? ''); break;
      case 'warn': console.warn(prefix, message, metadata ?? ''); break;
      case 'error': console.error(prefix, message, metadata ?? ''); break;
    }
  }

  /** Get all log entries. */
  getEntries(): DebugLogEntry[] {
    return [...this.#buffer];
  }

  /** Get filtered entries. */
  getFilteredEntries(
    category?: DebugLogEntry['category'],
    level?: DebugLogEntry['level'],
  ): DebugLogEntry[] {
    return this.#buffer.filter(entry =>
      (!category || entry.category === category) &&
      (!level || entry.level === level),
    );
  }

  /** Get buffer size. */
  getBufferSize(): number {
    return this.#buffer.length;
  }

  /** Get max buffer size. */
  getMaxSize(): number {
    return MAX_ENTRIES;
  }

  /** Clear the buffer. */
  clear(): void {
    this.#buffer.length = 0;
  }

  /** Export as JSON. */
  exportLog(): string {
    return JSON.stringify(this.#buffer, null, 2);
  }
}
