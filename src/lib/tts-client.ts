/**
 * ElevenLabs streaming TTS WebSocket client.
 * Uses eleven_flash_v2_5 for lowest latency (~75ms).
 * Includes chunk_length_schedule for faster first-byte.
 * Audited against ElevenLabs steering docs (April 2026).
 */

import type { ServiceConnectionState, VoiceSettings } from './types.js';
import { calculateBackoff } from './stt-client.js';

// ── Constants ───────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * chunk_length_schedule: character thresholds before audio generation starts.
 * Lower values = lower latency to first audio byte.
 * [50, 120, 200, 260] is aggressive for real-time translation.
 */
const CHUNK_LENGTH_SCHEDULE = [50, 120, 200, 260];

// ── Types ───────────────────────────────────────────────────

export type TTSConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected'; ws: WebSocket }
  | { status: 'error'; error: Error; lastAttempt: number };

export interface TTSConfig {
  voiceId: string;
  modelId: 'eleven_flash_v2_5' | 'eleven_multilingual_v2';
  outputFormat: 'pcm_24000';
  voiceSettings: VoiceSettings;
  apiKey: string;
}

// ── TTS Client ──────────────────────────────────────────────

export class TTSClient {
  #ws: WebSocket | null = null;
  #config: TTSConfig | null = null;
  #connectionState: TTSConnectionState = { status: 'disconnected' };
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #currentSequenceId = 0;
  #pendingText: string[] = [];

  onAudioChunk: ((pcm: Int16Array, sequenceId: number) => void) | null = null;
  onConnectionStateChange: ((state: ServiceConnectionState) => void) | null = null;
  onPlaybackEnd: ((sequenceId: number) => void) | null = null;

  getConnectionState(): TTSConnectionState {
    return this.#connectionState;
  }

  async connect(config: TTSConfig): Promise<void> {
    this.#config = config;
    this.#reconnectAttempt = 0;
    await this.#createConnection();
  }

  async disconnect(): Promise<void> {
    this.#clearTimers();
    this.#pendingText = [];

    if (this.#ws) {
      // Send empty text to close the stream gracefully
      if (this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ text: '' }));
      }
      this.#ws.close();
      this.#ws = null;
    }

    this.#setState({ status: 'disconnected' });
  }

  /**
   * Send a text token to the TTS service for synthesis.
   * Tokens stream incrementally from the LLM translation.
   */
  sendText(text: string): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ text }));
    } else {
      this.#pendingText.push(text);
    }
  }

  /**
   * Signal end of utterance — forces immediate audio generation
   * for any buffered text that hasn't hit the chunk_length_schedule threshold.
   */
  flush(): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ text: '', flush: true }));
    }
  }

  /**
   * Cancel current generation (barge-in).
   * Flushes remaining text and discards pending queue.
   */
  cancel(): void {
    this.flush();
    this.#pendingText = [];
  }

  setSequenceId(id: number): void {
    this.#currentSequenceId = id;
  }

  updateVoiceSettings(settings: Partial<VoiceSettings>): void {
    if (this.#config) {
      Object.assign(this.#config.voiceSettings, settings);
    }
  }

  async #createConnection(): Promise<void> {
    if (!this.#config) return;

    const { voiceId, modelId, apiKey } = this.#config;
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}`;

    this.#setState({ status: 'connecting', attempt: this.#reconnectAttempt });

    try {
      const ws = new WebSocket(url);
      this.#ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.#reconnectAttempt = 0;

        // Initialization message with chunk_length_schedule for low latency
        ws.send(JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: this.#config!.voiceSettings.stability,
            similarity_boost: this.#config!.voiceSettings.similarityBoost,
            style: this.#config!.voiceSettings.style,
            use_speaker_boost: this.#config!.voiceSettings.useSpeakerBoost,
          },
          generation_config: {
            chunk_length_schedule: CHUNK_LENGTH_SCHEDULE,
          },
          xi_api_key: apiKey,
          output_format: this.#config!.outputFormat,
        }));

        this.#setState({ status: 'connected' });
        this.#startHeartbeat();
        this.#flushPendingText();
      };

      ws.onmessage = (event: MessageEvent) => { this.#handleMessage(event); };
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

  #handleMessage(event: MessageEvent): void {
    // Binary audio data — PCM Int16 24kHz
    if (event.data instanceof ArrayBuffer) {
      const pcm = new Int16Array(event.data);
      this.onAudioChunk?.(pcm, this.#currentSequenceId);
      return;
    }

    // JSON message (base64 audio or isFinal)
    try {
      const msg = JSON.parse(event.data as string) as {
        audio?: string;
        isFinal?: boolean;
      };

      if (msg.audio) {
        const binary = atob(msg.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const pcm = new Int16Array(bytes.buffer);
        this.onAudioChunk?.(pcm, this.#currentSequenceId);
      }

      if (msg.isFinal) {
        this.onPlaybackEnd?.(this.#currentSequenceId);
      }
    } catch {
      // Skip malformed messages
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

  #flushPendingText(): void {
    for (const text of this.#pendingText) {
      this.sendText(text);
    }
    this.#pendingText = [];
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
      ? { status: 'connected', ws: this.#ws! }
      : state as TTSConnectionState;
    this.onConnectionStateChange?.(state);
  }
}
