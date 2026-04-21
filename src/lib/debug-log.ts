/**
 * Circular debug log buffer for diagnostics.
 * Never logs transcript content, translated text, or audio data (privacy).
 */

import type { DebugLogEntry } from './types.js';

// ── Constants ───────────────────────────────────────────────

const MAX_ENTRIES = 200;

// ── Debug Log ───────────────────────────────────────────────

const buffer: DebugLogEntry[] = [];

/**
 * Add a log entry to the circular buffer.
 */
export function log(
  level: DebugLogEntry['level'],
  category: DebugLogEntry['category'],
  message: string,
  metadata?: Record<string, unknown>
): void {
  const entry: DebugLogEntry = {
    timestamp: Date.now(),
    level,
    category,
    message,
  };

  if (metadata) {
    entry.metadata = metadata;
  }

  buffer.push(entry);
  while (buffer.length > MAX_ENTRIES) {
    buffer.shift();
  }

  // Also log to console in development
  const prefix = `[VB:${category}]`;
  switch (level) {
    case 'info': console.log(prefix, message, metadata ?? ''); break;
    case 'warn': console.warn(prefix, message, metadata ?? ''); break;
    case 'error': console.error(prefix, message, metadata ?? ''); break;
  }
}

/**
 * Get all log entries.
 */
export function getEntries(): DebugLogEntry[] {
  return [...buffer];
}

/**
 * Get entries filtered by category and/or level.
 */
export function getFilteredEntries(
  category?: DebugLogEntry['category'],
  level?: DebugLogEntry['level']
): DebugLogEntry[] {
  return buffer.filter(entry =>
    (!category || entry.category === category) &&
    (!level || entry.level === level)
  );
}

/**
 * Export the log buffer as a JSON string.
 */
export function exportLog(): string {
  return JSON.stringify(buffer, null, 2);
}

/**
 * Clear the log buffer.
 */
export function clearLog(): void {
  buffer.length = 0;
}

/**
 * Get the current buffer size.
 */
export function getBufferSize(): number {
  return buffer.length;
}
