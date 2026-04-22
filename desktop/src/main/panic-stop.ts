/**
 * Panic stop — immediate session termination.
 * Ctrl/Cmd+Shift+X kills all audio, connections, and in-memory data.
 */

import { globalShortcut } from 'electron';
import type { DesktopPipeline } from './desktop-pipeline.js';
import { DesktopDebugLog } from './desktop-debug-log.js';

// ── Panic Stop ──────────────────────────────────────────────

export class PanicStop {
  #pipeline: DesktopPipeline;
  #debugLog: DesktopDebugLog;
  #registered = false;

  constructor(pipeline: DesktopPipeline, debugLog: DesktopDebugLog) {
    this.#pipeline = pipeline;
    this.#debugLog = debugLog;
  }

  /** Register the global panic stop shortcut. */
  register(): void {
    if (this.#registered) return;

    const accelerator = process.platform === 'darwin'
      ? 'Cmd+Shift+X'
      : 'Ctrl+Shift+X';

    globalShortcut.register(accelerator, () => {
      this.execute();
    });

    this.#registered = true;
  }

  /** Execute panic stop — deterministic cleanup. */
  async execute(): Promise<void> {
    this.#debugLog.log('warn', 'pipeline', 'PANIC STOP triggered');

    try {
      await this.#pipeline.stopSession('panic-stop');
    } catch (err) {
      this.#debugLog.log('error', 'pipeline', 'Panic stop error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Unregister the shortcut. */
  unregister(): void {
    if (!this.#registered) return;
    const accelerator = process.platform === 'darwin'
      ? 'Cmd+Shift+X'
      : 'Ctrl+Shift+X';
    globalShortcut.unregister(accelerator);
    this.#registered = false;
  }
}
