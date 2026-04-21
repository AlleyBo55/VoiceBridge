/**
 * MessageChannel-based audio bridge between offscreen document
 * and content script. Bypasses the service worker for low-latency
 * audio data transfer using Transferable ArrayBuffers.
 */

import type { AudioRoutingState, EchoState, AudioBridgeMessage } from './types.js';

/**
 * Offscreen-side sender for the audio bridge.
 * Sends PCM audio chunks as Transferable ArrayBuffers (zero-copy),
 * track injection commands, and state synchronization messages
 * through a MessagePort.
 */
export class AudioBridgeSender {
  #port: MessagePort | null = null;
  #pendingCommands = new Map<number, { resolve: (v: boolean) => void; reject: (e: Error) => void }>();
  #commandId = 0;

  /**
   * Attach the MessagePort provided by the service worker.
   * Sets up the message handler for track command responses.
   */
  attachPort(port: MessagePort): void {
    this.#port = port;
    port.onmessage = (event: MessageEvent) => {
      const msg = event.data as AudioBridgeMessage;
      if (msg.type === 'track-response') {
        const pending = this.#pendingCommands.get(this.#commandId);
        if (pending) {
          pending.resolve(msg.success);
          this.#pendingCommands.delete(this.#commandId);
        }
      }
    };
  }

  /**
   * Send a PCM audio chunk as a Transferable ArrayBuffer (zero-copy).
   *
   * @param pcm - Raw PCM audio data to transfer
   * @param sequenceId - Utterance sequence ID for ordering
   */
  sendAudioChunk(pcm: ArrayBuffer, sequenceId: number): void {
    if (!this.#port) return;
    const msg: AudioBridgeMessage = { type: 'audio-chunk', pcm, sequenceId };
    this.#port.postMessage(msg, [pcm]);
  }

  /**
   * Send a track injection/restoration command and wait for acknowledgment.
   * Times out after 5 seconds, returning false on timeout.
   *
   * @param command - The track command to send
   * @returns Whether the command was acknowledged successfully
   */
  async sendTrackCommand(command: 'inject' | 'restore' | 'status'): Promise<boolean> {
    if (!this.#port) return false;
    this.#commandId++;
    const id = this.#commandId;
    return new Promise((resolve, _reject) => {
      this.#pendingCommands.set(id, { resolve, reject: _reject });
      const msg: AudioBridgeMessage = { type: 'track-command', command };
      this.#port!.postMessage(msg);
      setTimeout(() => {
        if (this.#pendingCommands.has(id)) {
          this.#pendingCommands.delete(id);
          resolve(false);
        }
      }, 5000);
    });
  }

  /**
   * Sync routing and echo cancellation state to the content script.
   *
   * @param routingState - Current audio routing state
   * @param echoState - Current echo cancellation state
   */
  syncState(routingState: AudioRoutingState, echoState: EchoState): void {
    if (!this.#port) return;
    const msg: AudioBridgeMessage = { type: 'state-sync', routingState, echoState };
    this.#port.postMessage(msg);
  }

  /** Check if the MessagePort is connected. */
  isConnected(): boolean {
    return this.#port !== null;
  }

  /** Close the port and clear all pending commands. */
  close(): void {
    this.#port?.close();
    this.#port = null;
    this.#pendingCommands.clear();
  }
}


/**
 * Content-script-side receiver for the audio bridge.
 * Receives PCM audio chunks, track commands, and state sync messages
 * from the offscreen document through a MessagePort.
 */
export class AudioBridgeReceiver {
  #port: MessagePort | null = null;

  /** Callback for received audio chunks. */
  onAudioChunk: ((pcm: ArrayBuffer, sequenceId: number) => void) | null = null;

  /** Callback for track injection/restoration commands. */
  onTrackCommand: ((command: 'inject' | 'restore' | 'status') => void) | null = null;

  /** Callback for routing and echo state synchronization. */
  onStateSync: ((routingState: AudioRoutingState, echoState: EchoState) => void) | null = null;

  /**
   * Attach the MessagePort provided by the service worker.
   * Sets up the message handler dispatching to registered callbacks.
   */
  attachPort(port: MessagePort): void {
    this.#port = port;
    port.onmessage = (event: MessageEvent) => {
      const msg = event.data as AudioBridgeMessage;
      switch (msg.type) {
        case 'audio-chunk':
          this.onAudioChunk?.(msg.pcm, msg.sequenceId);
          break;
        case 'track-command':
          this.onTrackCommand?.(msg.command);
          break;
        case 'state-sync':
          this.onStateSync?.(msg.routingState, msg.echoState);
          break;
      }
    };
  }

  /**
   * Send a track command response back to the offscreen document.
   *
   * @param success - Whether the command was executed successfully
   * @param error - Optional error message if the command failed
   */
  sendTrackResponse(success: boolean, error?: string): void {
    if (!this.#port) return;
    const msg: AudioBridgeMessage = error !== undefined
      ? { type: 'track-response', success, error }
      : { type: 'track-response', success };
    this.#port.postMessage(msg);
  }

  /** Check if the MessagePort is connected. */
  isConnected(): boolean {
    return this.#port !== null;
  }

  /** Close the port and release resources. */
  close(): void {
    this.#port?.close();
    this.#port = null;
  }
}
