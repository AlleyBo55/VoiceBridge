/**
 * Deterministic ordered cleanup of all pipeline resources.
 * Each step is try/catch wrapped — failures are logged but don't
 * block subsequent steps.
 */

import type { CleanupTarget, CleanupResult } from './types.js';

/**
 * Execute cleanup targets in deterministic order.
 * Every target is attempted regardless of prior failures.
 *
 * @param targets - Ordered list of cleanup targets to execute
 * @returns A result containing success status, collected errors, and duration
 */
export async function executeCleanupSequence(
  targets: CleanupTarget[],
): Promise<CleanupResult> {
  const start = Date.now();
  const errors: Array<{ name: string; error: Error }> = [];

  for (const target of targets) {
    try {
      await target.cleanup();
    } catch (err) {
      errors.push({
        name: target.name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return {
    success: errors.length === 0,
    errors,
    durationMs: Date.now() - start,
  };
}

/**
 * Build the standard pipeline cleanup target list.
 * Order: AudioCapture → STT → Translation → TTS → AudioOutput →
 *        EchoCancellation → LatencyMonitor.
 * Null modules are skipped.
 *
 * @param modules - References to pipeline modules (null if not initialized)
 * @returns Ordered array of cleanup targets
 */
export function buildPipelineCleanupTargets(modules: {
  audioCapture: { stop(): Promise<void> } | null;
  sttClient: { disconnect(): Promise<void> } | null;
  translationEngine: { destroy(): void } | null;
  ttsClient: { disconnect(): Promise<void> } | null;
  audioOutput: { destroy(): Promise<void> } | null;
  echoCancellation: { destroy(): void } | null;
  latencyMonitor: { clear(): void } | null;
}): CleanupTarget[] {
  const targets: CleanupTarget[] = [];

  if (modules.audioCapture) {
    targets.push({ name: 'AudioCapture', cleanup: () => modules.audioCapture!.stop() });
  }
  if (modules.sttClient) {
    targets.push({ name: 'STTClient', cleanup: () => modules.sttClient!.disconnect() });
  }
  if (modules.translationEngine) {
    targets.push({
      name: 'TranslationEngine',
      cleanup: () => { modules.translationEngine!.destroy(); },
    });
  }
  if (modules.ttsClient) {
    targets.push({ name: 'TTSClient', cleanup: () => modules.ttsClient!.disconnect() });
  }
  if (modules.audioOutput) {
    targets.push({ name: 'AudioOutput', cleanup: () => modules.audioOutput!.destroy() });
  }
  if (modules.echoCancellation) {
    targets.push({
      name: 'EchoCancellation',
      cleanup: () => { modules.echoCancellation!.destroy(); },
    });
  }
  if (modules.latencyMonitor) {
    targets.push({
      name: 'LatencyMonitor',
      cleanup: () => { modules.latencyMonitor!.clear(); },
    });
  }

  return targets;
}
