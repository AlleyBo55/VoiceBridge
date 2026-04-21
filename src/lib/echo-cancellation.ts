/**
 * Echo cancellation state machine.
 * Prevents TTS output from being re-captured by the microphone.
 * Pure state transitions — no side effects in the transition function.
 */

import type { EchoState, EchoEvent } from './types.js';

// ── Constants ───────────────────────────────────────────────

/** Time to wait after TTS ends before re-enabling mic (echo tail) */
const TRANSITION_DELAY_MS = 200;

/** Barge-in fade-out duration */
const BARGE_IN_FADE_MS = 50;

// ── Pure State Transition ───────────────────────────────────

/**
 * Pure state transition function for echo cancellation.
 * No side effects — returns the new state given current state and event.
 */
export function transitionEchoState(
  current: EchoState,
  event: EchoEvent,
  ghostMode: boolean = false
): EchoState {
  switch (current.status) {
    case 'listening':
      if (event.type === 'tts_start') {
        return { status: 'speaking', ttsStartedAt: Date.now() };
      }
      return current;

    case 'speaking':
      // Ghost Mode: no barge-in detection (whisper too sensitive)
      if (event.type === 'barge_in' && !ghostMode) {
        return { status: 'listening' };
      }
      if (event.type === 'tts_end') {
        return { status: 'transitioning', ttsEndedAt: Date.now() };
      }
      return current;

    case 'transitioning':
      if (event.type === 'transition_complete') {
        return { status: 'listening' };
      }
      // Allow barge-in during transition (unless Ghost Mode)
      if (event.type === 'barge_in' && !ghostMode) {
        return { status: 'listening' };
      }
      return current;
  }
}

/**
 * Check if the microphone should be muted in the given state.
 */
export function isMicMuted(state: EchoState): boolean {
  return state.status === 'speaking' || state.status === 'transitioning';
}

// ── Echo Cancellation Module ────────────────────────────────

export interface EchoCancellationCallbacks {
  onMuteMic: () => void;
  onUnmuteMic: () => void;
  onStopTTS: () => void;
  onFadeOutTTS: (durationMs: number) => void;
  onStateChange: (state: EchoState) => void;
}

/**
 * Stateful echo cancellation controller.
 * Coordinates mic muting and TTS stopping based on state transitions.
 */
export class EchoCancellationModule {
  #state: EchoState = { status: 'listening' };
  #ghostMode = false;
  #transitionTimer: ReturnType<typeof setTimeout> | null = null;
  #callbacks: EchoCancellationCallbacks;

  constructor(callbacks: EchoCancellationCallbacks) {
    this.#callbacks = callbacks;
  }

  getState(): EchoState {
    return this.#state;
  }

  setGhostMode(enabled: boolean): void {
    this.#ghostMode = enabled;
  }

  /**
   * Process an echo event and apply side effects.
   */
  handleEvent(event: EchoEvent): void {
    const prev = this.#state;
    const next = transitionEchoState(prev, event, this.#ghostMode);

    if (next === prev) return;

    this.#state = next;
    this.#callbacks.onStateChange(next);

    // Apply side effects based on transition
    if (prev.status === 'listening' && next.status === 'speaking') {
      this.#callbacks.onMuteMic();
    }

    if (prev.status === 'speaking' && next.status === 'listening') {
      // Barge-in: fade out TTS, unmute mic
      this.#callbacks.onFadeOutTTS(BARGE_IN_FADE_MS);
      this.#callbacks.onStopTTS();
      this.#callbacks.onUnmuteMic();
    }

    if (prev.status === 'speaking' && next.status === 'transitioning') {
      // TTS ended, start transition timer
      this.#clearTransitionTimer();
      this.#transitionTimer = setTimeout(() => {
        this.handleEvent({ type: 'transition_complete' });
      }, TRANSITION_DELAY_MS);
    }

    if (next.status === 'listening' && prev.status === 'transitioning') {
      this.#clearTransitionTimer();
      this.#callbacks.onUnmuteMic();
    }
  }

  /** Reset to listening state and clean up timers. */
  reset(): void {
    this.#clearTransitionTimer();
    this.#state = { status: 'listening' };
    this.#callbacks.onUnmuteMic();
    this.#callbacks.onStateChange(this.#state);
  }

  destroy(): void {
    this.#clearTransitionTimer();
  }

  #clearTransitionTimer(): void {
    if (this.#transitionTimer !== null) {
      clearTimeout(this.#transitionTimer);
      this.#transitionTimer = null;
    }
  }
}
