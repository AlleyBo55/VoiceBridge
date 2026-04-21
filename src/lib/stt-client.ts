/**
 * ElevenLabs Scribe v2 Realtime STT WebSocket client.
 * Uses the latest API: base64 audio chunks, committed_transcript events.
 * Audited against ElevenLabs steering docs (April 2026).
 */

import type { ServiceConnectionState } from './types.js';

// ── Constants ───────────────────────────────────────────────

const STT_ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/stream';
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10000;
const RECONNECT_BUFFER_SECONDS = 10;

// ── Types ───────────────────────────────────────────────────

export type STTConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected'; ws: WebSocket; sessionToken: string }
  | { status: 'error'; error: Error; lastAttempt: number };

export interface STTConfig {
  languageCode: string;
  model: 'scribe_v2_realtime';
  encoding: 'pcm_16000';
}

export interface STTTranscript {
  text: string;
  language: string;
  isFinal: boolean;
  sequenceId: number;
  timestamp: number;
}

// ── Backoff Calculation ─────────────────────────────────────

/**
 * Calculate exponential backoff delay.
 * min(baseDelay * 2^attempt, maxDelay)
 */
export function calculateBackoff(
  attempt: number,
  baseDelay: number = BASE_RECONNECT_DELAY_MS,
  maxDelay: number = MAX_RECONNECT_DELAY_MS
): number {
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
}

// ── Helpers ─────────────────────────────────────────────────

/** Convert Int16Array PCM to base64 string for the API */
function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

// ── STT Client ──────────────────────────────────────────────

export class STTClient {
  #ws: WebSocket | null = null;
  #config: STTConfig | null = null;
  #connectionState: STTConnectionState = { status: 'disconnected' };
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #audioBuffer: Int16Array[] = [];
  #audioBufferDuration = 0;
  #currentSequenceId = 0;

  onPartialTranscript: ((transcript: STTTranscript) => void) | null = null;
  onFinalTranscript: ((transcript: STTTranscript) => void) | null = null;
  onConnectionStateChange: ((state: ServiceConnectionState) => void) | null = null;

  constructor(_apiKey: string) {
    // API key used for token acquisition
  }

  getConnectionState(): STTConnectionState {
    return this.#connectionState;
  }

  async connect(config: STTConfig): Promise<void> {
    this.#config = config;
    this.#reconnectAttempt = 0;
    await this.#createConnection();
  }

  async disconnect(): Promise<void> {
    this.#clearTimers();
    this.#audioBuffer = [];
    this.#audioBufferDuration = 0;

    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      // Close stream gracefully
      this.#ws.send(JSON.stringify({ message_type: 'close_stream' }));
      this.#ws.close();
    }
    this.#ws = null;
    this.#setState({ status: 'disconnected' });
  }

  /**
   * Send a PCM Int16 audio chunk to the STT service.
   * Converts to base64 per the Scribe v2 Realtime API.
   */
  sendAudio(chunk: Int16Array): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: pcmToBase64(chunk),
        sample_rate: 16000,
      }));
    } else {
      // Buffer audio during disconnection (max 10 seconds)
      this.#audioBuffer.push(chunk);
      this.#audioBufferDuration += chunk.length / 16000;
      while (this.#audioBufferDuration > RECONNECT_BUFFER_SECONDS && this.#audioBuffer.length > 0) {
        const dropped = this.#audioBuffer.shift();
        if (dropped) this.#audioBufferDuration -= dropped.length / 16000;
      }
    }
  }

  /**
   * Force finalization of the current transcript segment.
   */
  commit(): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ message_type: 'commit' }));
    }
  }

  setSequenceId(id: number): void {
    this.#currentSequenceId = id;
  }

  async #createConnection(): Promise<void> {
    this.#setState({ status: 'connecting', attempt: this.#reconnectAttempt });

    try {
      const ws = new WebSocket(STT_ENDPOINT);
      this.#ws = ws;

      ws.onopen = () => {
        this.#reconnectAttempt = 0;

        // Send config for Scribe v2 Realtime
        if (this.#config) {
          ws.send(JSON.stringify({
            type: 'config',
            encoding: this.#config.encoding,
            language_code: this.#config.languageCode,
            model: this.#config.model,
          }));
        }

        this.#setState({ status: 'connected' });
        this.#startHeartbeat();
        this.#flushAudioBuffer();
      };

      ws.onmessage = (event: MessageEvent) => {
        this.#handleMessage(event.data as string);
      };

      ws.onerror = () => { this.#handleDisconnect(); };
      ws.onclose = () => { this.#handleDisconnect(); };
    } catch (error) {
      this.#setState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Connection failed',
        retryable: true,
      });
      this.#scheduleReconnect();
    }
  }

  #handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as {
        type: string;
        text?: string;
        language?: string;
        message?: string;
        code?: string;
      };

      switch (msg.type) {
        // Scribe v2 Realtime events
        case 'partial_transcript':
          this.onPartialTranscript?.({
            text: msg.text ?? '',
            language: msg.language ?? '',
            isFinal: false,
            sequenceId: this.#currentSequenceId,
            timestamp: Date.now(),
          });
          break;

        case 'committed_transcript':
        case 'committed_transcript_with_timestamps':
          this.onFinalTranscript?.({
            text: msg.text ?? '',
            language: msg.language ?? '',
            isFinal: true,
            sequenceId: this.#currentSequenceId,
            timestamp: Date.now(),
          });
          break;

        // Legacy Scribe v1 events (backward compat)
        case 'transcript.partial':
          this.onPartialTranscript?.({
            text: msg.text ?? '',
            language: msg.language ?? '',
            isFinal: false,
            sequenceId: this.#currentSequenceId,
            timestamp: Date.now(),
          });
          break;

        case 'transcript.final':
          this.onFinalTranscript?.({
            text: msg.text ?? '',
            language: msg.language ?? '',
            isFinal: true,
            sequenceId: this.#currentSequenceId,
            timestamp: Date.now(),
          });
          break;

        case 'session_started':
          // Session confirmed — ready for audio
          break;

        case 'error':
          console.error('[STT] Server error:', msg.code, msg.message);
          break;
      }
    } catch {
      console.error('[STT] Failed to parse message');
    }
  }

  #handleDisconnect(): void {
    this.#clearTimers();
    if (this.#connectionState.status === 'disconnected') return;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.#setState({
        status: 'error',
        error: `Failed after ${MAX_RECONNECT_ATTEMPTS} attempts`,
        retryable: false,
      });
      return;
    }

    const delay = calculateBackoff(this.#reconnectAttempt);
    this.#reconnectAttempt++;
    this.#reconnectTimer = setTimeout(() => { this.#createConnection(); }, delay);
  }

  #flushAudioBuffer(): void {
    for (const chunk of this.#audioBuffer) {
      this.sendAudio(chunk);
    }
    this.#audioBuffer = [];
    this.#audioBufferDuration = 0;
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        try { this.#ws.send(new Uint8Array(0)); }
        catch { this.#handleDisconnect(); }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  #clearTimers(): void {
    if (this.#heartbeatTimer) { clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = null; }
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
  }

  #setState(state: ServiceConnectionState): void {
    this.#connectionState = state.status === 'connected'
      ? { status: 'connected', ws: this.#ws!, sessionToken: '' }
      : state as STTConnectionState;
    this.onConnectionStateChange?.(state);
  }
}
