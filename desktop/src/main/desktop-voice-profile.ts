/**
 * Desktop voice profile manager — multi-voice support.
 * Users can create multiple voice clones, pick one as active,
 * add new ones, or delete any. Each clone is a separate ElevenLabs voice.
 *
 * SECURITY: API key never leaves main process.
 */

import { DesktopSettingsStore } from './desktop-settings-store.js';
import { DesktopDebugLog } from './desktop-debug-log.js';

// ── Constants ───────────────────────────────────────────────

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// ── Types ───────────────────────────────────────────────────

export interface VoiceProfile {
  voiceId: string;
  name: string;
  createdAt: number;
}

export type VoiceRecordingState =
  | { status: 'idle' }
  | { status: 'recording'; durationMs: number }
  | { status: 'uploading'; progress: number }
  | { status: 'ready'; voiceId: string }
  | { status: 'error'; message: string };

// ── Desktop Voice Profile ───────────────────────────────────

export class DesktopVoiceProfile {
  #settings: DesktopSettingsStore;
  #debugLog: DesktopDebugLog;
  #recordedBuffer: Buffer | null = null;
  #recordingStart = 0;
  #state: VoiceRecordingState = { status: 'idle' };

  onStateChange: ((state: VoiceRecordingState) => void) | null = null;

  constructor(settings: DesktopSettingsStore, debugLog: DesktopDebugLog) {
    this.#settings = settings;
    this.#debugLog = debugLog;
  }

  getState(): VoiceRecordingState {
    return this.#state;
  }

  /** Start recording a voice sample. */
  startRecording(): void {
    this.#recordedBuffer = null;
    this.#recordingStart = Date.now();
    this.#setState({ status: 'recording', durationMs: 0 });
    this.#debugLog.log('info', 'audio', 'Voice recording started');
  }

  /** Stop recording and store the audio buffer from the renderer. */
  stopRecording(audioData: Buffer): { durationMs: number } {
    const durationMs = Date.now() - this.#recordingStart;
    this.#recordedBuffer = audioData;
    this.#setState({ status: 'idle' });
    this.#debugLog.log('info', 'audio', `Voice recording stopped: ${durationMs}ms, ${audioData.length} bytes`);
    return { durationMs };
  }

  /** Upload the recorded voice sample to ElevenLabs. Returns the voice ID. */
  async upload(): Promise<string> {
    if (!this.#recordedBuffer || this.#recordedBuffer.length === 0) {
      throw new Error('No recording available. Record a voice sample first.');
    }

    const apiKey = await this.#settings.get('elevenLabsApiKey');
    if (!apiKey) throw new Error('ElevenLabs API key not configured');

    this.#setState({ status: 'uploading', progress: 0 });
    this.#debugLog.log('info', 'api', 'Uploading voice sample to ElevenLabs');

    try {
      const boundary = `----VoiceBridge${Date.now()}`;
      const name = `VoiceBridge-${new Date().toISOString().slice(0, 16).replace('T', '-')}`;

      const parts: Buffer[] = [];
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="voice-sample.webm"\r\nContent-Type: audio/webm\r\n\r\n`));
      parts.push(this.#recordedBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="labels"\r\n\r\n${JSON.stringify({ source: 'voicebridge-desktop' })}\r\n`));
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);
      this.#setState({ status: 'uploading', progress: 50 });

      const response = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { voice_id: string };
      const voiceId = data.voice_id;

      // Set as active voice
      await this.#settings.set('voiceProfileId', voiceId);
      await this.#settings.flush();

      this.#setState({ status: 'ready', voiceId });
      this.#debugLog.log('info', 'api', `Voice clone created: ${voiceId}`);
      this.#recordedBuffer = null;
      return voiceId;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      this.#setState({ status: 'error', message });
      this.#debugLog.log('error', 'api', `Voice upload failed: ${message}`);
      throw err;
    }
  }

  /**
   * List all VoiceBridge voice clones from the user's ElevenLabs account.
   * Filters to only voices labeled with source: voicebridge-desktop.
   */
  async listVoices(): Promise<VoiceProfile[]> {
    const apiKey = await this.#settings.get('elevenLabsApiKey');
    if (!apiKey) return [];

    try {
      const response = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return [];

      const data = await response.json() as {
        voices: Array<{
          voice_id: string;
          name: string;
          labels?: Record<string, string>;
          created_at_unix?: number;
          category?: string;
        }>;
      };

      // Return VoiceBridge clones + any user-created cloned voices
      return data.voices
        .filter(v => v.category === 'cloned' || v.labels?.['source'] === 'voicebridge-desktop')
        .map(v => ({
          voiceId: v.voice_id,
          name: v.name,
          createdAt: (v.created_at_unix ?? 0) * 1000,
        }));
    } catch {
      return [];
    }
  }

  /** Set a voice as the active profile for translation. */
  async setActiveVoice(voiceId: string): Promise<void> {
    await this.#settings.set('voiceProfileId', voiceId);
    await this.#settings.flush();
    this.#debugLog.log('info', 'state', `Active voice set: ${voiceId}`);
  }

  /** Get the currently active voice ID. */
  async getActiveVoiceId(): Promise<string> {
    return this.#settings.get('voiceProfileId');
  }

  /** Delete a voice profile from ElevenLabs. */
  async deleteProfile(voiceId: string): Promise<void> {
    const apiKey = await this.#settings.get('elevenLabsApiKey');
    if (!apiKey) throw new Error('ElevenLabs API key not configured');

    const response = await fetch(`${ELEVENLABS_API_BASE}/voices/${voiceId}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) throw new Error(`Delete failed: ${response.status}`);

    // If deleted voice was active, clear it
    const activeId = await this.#settings.get('voiceProfileId');
    if (activeId === voiceId) {
      await this.#settings.set('voiceProfileId', '');
      await this.#settings.flush();
    }

    this.#debugLog.log('info', 'api', `Voice profile deleted: ${voiceId}`);
  }

  /** Preview a voice with a test phrase. */
  async preview(voiceId: string, text: string, _language: string): Promise<ArrayBuffer> {
    const apiKey = await this.#settings.get('elevenLabsApiKey');
    if (!apiKey) throw new Error('ElevenLabs API key not configured');

    const response = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });

    if (!response.ok) throw new Error(`Preview failed: ${response.status}`);
    return response.arrayBuffer();
  }

  #setState(state: VoiceRecordingState): void {
    this.#state = state;
    this.onStateChange?.(state);
  }
}
