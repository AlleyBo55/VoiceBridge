/**
 * Voice profile management — recording, validation, upload, deletion, preview.
 * Uses ElevenLabs Voice Cloning REST API.
 */

import type { VoiceProfileState, VoiceSampleError, Result } from './types.js';

// ── Constants ───────────────────────────────────────────────

const MIN_DURATION_MS = 30000;
const MAX_DURATION_MS = 120000;
const MIN_RMS_DB = -30;
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// ── Validation ──────────────────────────────────────────────

/**
 * Validate a voice sample meets quality requirements.
 */
export function validateVoiceSample(
  durationMs: number,
  averageRmsDb: number
): Result<void, VoiceSampleError> {
  if (durationMs < MIN_DURATION_MS) {
    return { ok: false, error: { code: 'too-short', minDurationMs: MIN_DURATION_MS } };
  }
  if (durationMs > MAX_DURATION_MS) {
    return { ok: false, error: { code: 'too-long', maxDurationMs: MAX_DURATION_MS } };
  }
  if (averageRmsDb <= MIN_RMS_DB) {
    return { ok: false, error: { code: 'too-noisy', averageRmsDb, thresholdDb: -30 } };
  }
  return { ok: true, value: undefined };
}

// ── Voice Profile Manager ───────────────────────────────────

export class VoiceProfileManager {
  #state: VoiceProfileState = { status: 'not-set-up' };
  #apiKey: string;
  #mediaRecorder: MediaRecorder | null = null;
  #recordedChunks: Blob[] = [];
  #recordingStartTime = 0;

  onStateChange: ((state: VoiceProfileState) => void) | null = null;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  getState(): VoiceProfileState {
    return this.#state;
  }

  /**
   * Start recording a voice sample from the microphone.
   */
  async startRecording(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false },
    });

    this.#recordedChunks = [];
    this.#recordingStartTime = Date.now();

    this.#mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    this.#mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.#recordedChunks.push(event.data);
      }
    };

    this.#mediaRecorder.start(1000); // Collect data every second
    this.#setState({ status: 'recording', durationMs: 0 });

    // Update duration periodically
    const interval = setInterval(() => {
      if (this.#state.status === 'recording') {
        const durationMs = Date.now() - this.#recordingStartTime;
        this.#setState({ status: 'recording', durationMs });

        if (durationMs >= MAX_DURATION_MS) {
          clearInterval(interval);
          this.stopRecording();
        }
      } else {
        clearInterval(interval);
      }
    }, 500);
  }

  /**
   * Stop recording and return the audio blob.
   */
  async stopRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.#mediaRecorder) {
        resolve(new Blob());
        return;
      }

      this.#mediaRecorder.onstop = () => {
        const blob = new Blob(this.#recordedChunks, { type: 'audio/webm' });

        // Stop all tracks
        for (const track of this.#mediaRecorder!.stream.getTracks()) {
          track.stop();
        }

        this.#mediaRecorder = null;
        this.#recordedChunks = [];
        resolve(blob);
      };

      this.#mediaRecorder.stop();
    });
  }

  /**
   * Upload a voice sample to ElevenLabs for cloning.
   */
  async upload(audioBlob: Blob): Promise<string> {
    this.#setState({ status: 'uploading', progress: 0 });

    const formData = new FormData();
    formData.append('files', audioBlob, 'voice-sample.webm');
    formData.append('name', `VoiceBridge-${crypto.randomUUID().slice(0, 8)}`);
    formData.append('labels', JSON.stringify({ source: 'voicebridge' }));

    try {
      this.#setState({ status: 'uploading', progress: 50 });

      const response = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
        method: 'POST',
        headers: { 'xi-api-key': this.#apiKey },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} — ${errorText}`);
      }

      const data = await response.json() as { voice_id: string };
      this.#setState({ status: 'ready', voiceId: data.voice_id, createdAt: Date.now() });
      return data.voice_id;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      this.#setState({ status: 'error', error: message });
      throw error;
    }
  }

  /**
   * Delete the voice profile from ElevenLabs.
   */
  async delete(voiceId: string): Promise<void> {
    const response = await fetch(`${ELEVENLABS_API_BASE}/voices/${voiceId}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': this.#apiKey },
    });

    if (!response.ok) {
      throw new Error(`Delete failed: ${response.status}`);
    }

    this.#setState({ status: 'not-set-up' });
  }

  /**
   * Preview the cloned voice with a test phrase.
   */
  async preview(voiceId: string, text: string, _language: string): Promise<ArrayBuffer> {
    const response = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.#apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Preview failed: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  #setState(state: VoiceProfileState): void {
    this.#state = state;
    this.onStateChange?.(state);
  }
}
