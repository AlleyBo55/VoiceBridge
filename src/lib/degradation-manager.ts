/**
 * Manages the degradation cascade based on service health.
 * Pure logic — the PipelineOrchestrator applies side effects.
 *
 * Degradation levels:
 *   full:               STT ✓  LLM ✓  TTS ✓
 *   text-only:          STT ✓  LLM ✓  TTS ✗
 *   transcription-only: STT ✓  LLM ✗  TTS ✗
 *   passthrough:        STT ✗  LLM ✗  TTS ✗
 */

import type { DegradationLevel, ServiceConnectionState } from './types.js';

/** Health snapshot for all three pipeline services. */
export interface ServiceHealth {
  stt: ServiceConnectionState;
  tts: ServiceConnectionState;
  llm: ServiceConnectionState;
}

/**
 * Determine the highest available degradation level given service health.
 *
 * @param health - Current connection state of each service
 * @returns The highest degradation level the pipeline can operate at
 */
export function computeDegradationLevel(health: ServiceHealth): DegradationLevel {
  const sttOk = health.stt.status === 'connected';
  const llmOk = health.llm.status === 'connected';
  const ttsOk = health.tts.status === 'connected';

  if (sttOk && llmOk && ttsOk) return 'full';
  if (sttOk && llmOk) return 'text-only';
  if (sttOk) return 'transcription-only';
  return 'passthrough';
}

/**
 * Check if a transition from `current` to `target` is valid.
 * Downgrade must step one level at a time through the cascade.
 * Upgrade can skip levels freely.
 *
 * @param current - The current degradation level
 * @param target - The desired degradation level
 * @returns Whether the transition is permitted
 */
export function isValidDegradation(
  current: DegradationLevel,
  target: DegradationLevel,
): boolean {
  const order: DegradationLevel[] = ['full', 'text-only', 'transcription-only', 'passthrough'];
  const currentIdx = order.indexOf(current);
  const targetIdx = order.indexOf(target);

  // Downgrade: must step one level at a time
  if (targetIdx > currentIdx) return targetIdx === currentIdx + 1;
  // Upgrade: can skip levels
  return true;
}

/**
 * Get the next degradation level in the cascade (one step down).
 * Returns null if already at the lowest level (passthrough).
 *
 * @param current - The current degradation level
 * @returns The next lower degradation level, or null at passthrough
 */
export function getNextDegradationLevel(
  current: DegradationLevel,
): DegradationLevel | null {
  switch (current) {
    case 'full': return 'text-only';
    case 'text-only': return 'transcription-only';
    case 'transcription-only': return 'passthrough';
    case 'passthrough': return null;
  }
}
