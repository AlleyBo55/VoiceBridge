/**
 * Pure state machine for audio routing.
 * No side effects — the PipelineOrchestrator calls these functions
 * and applies side effects based on the returned values.
 */

import type { AudioRoutingState, AudioRoutingEvent } from './types.js';

/**
 * Pure audio routing state transition.
 * Maps to what audio the meeting hears:
 *   PASSTHROUGH → original mic
 *   MUTED → silence (mic captured for STT only)
 *   TTS_PLAYING → TTS audio
 *   BARGE_IN → original mic (TTS fading out)
 *
 * @param current - The current routing state
 * @param event - The event triggering the transition
 * @returns The new routing state after applying the event
 */
export function transitionRoutingState(
  current: AudioRoutingState,
  event: AudioRoutingEvent,
): AudioRoutingState {
  switch (current) {
    case 'PASSTHROUGH':
      if (event.type === 'session_start') return 'MUTED';
      return current;
    case 'MUTED':
      if (event.type === 'tts_start') return 'TTS_PLAYING';
      if (event.type === 'session_stop') return 'PASSTHROUGH';
      if (event.type === 'degraded_to_passthrough') return 'PASSTHROUGH';
      return current;
    case 'TTS_PLAYING':
      if (event.type === 'tts_end') return 'MUTED';
      if (event.type === 'barge_in') return 'BARGE_IN';
      if (event.type === 'session_stop') return 'PASSTHROUGH';
      return current;
    case 'BARGE_IN':
      if (event.type === 'vad_speech_end') return 'MUTED';
      if (event.type === 'session_stop') return 'PASSTHROUGH';
      return current;
  }
}

/**
 * Determine what the meeting hears in a given routing state.
 *
 * @param state - The current audio routing state
 * @returns The audio source identifier for the given state
 */
export function getAudioSource(
  state: AudioRoutingState,
): 'mic' | 'silence' | 'tts' | 'mic-fade-tts' {
  switch (state) {
    case 'PASSTHROUGH': return 'mic';
    case 'MUTED': return 'silence';
    case 'TTS_PLAYING': return 'tts';
    case 'BARGE_IN': return 'mic-fade-tts';
  }
}

/**
 * Map routing state to echo cancellation coordination.
 * MUTED + TTS_PLAYING → echo cancellation SPEAKING
 * PASSTHROUGH + BARGE_IN → echo cancellation LISTENING
 *
 * @param state - The current audio routing state
 * @returns The echo cancellation mode for the given state
 */
export function getEchoCancellationMode(
  state: AudioRoutingState,
): 'listening' | 'speaking' {
  switch (state) {
    case 'PASSTHROUGH':
    case 'BARGE_IN':
      return 'listening';
    case 'MUTED':
    case 'TTS_PLAYING':
      return 'speaking';
  }
}
