# VoiceBridge — API Reference

> Every module, every interface, every type. The complete developer reference.

## Table of Contents

- [Core Types](#core-types)
- [AudioCaptureModule](#audiocapturemodule)
- [STTClient](#sttclient)
- [TranslationEngine](#translationengine)
- [TTSClient](#ttsclient)
- [AudioOutputModule](#audiooutputmodule)
- [EchoCancellationModule](#echocancellationmodule)
- [MeetingDetector](#meetingdetector)
- [VoiceProfileManager](#voiceprofilemanager)
- [LatencyMonitor](#latencymonitor)
- [SettingsStore](#settingsstore)
- [MessageBus](#messagebus)
- [DebugLog](#debuglog)

---

## Core Types

All types are defined in `src/lib/types.ts`.

### Pipeline Types

```typescript
type PipelineStage = 'CAPTURED' | 'TRANSCRIBED' | 'TRANSLATED' | 'SYNTHESIZED' | 'PLAYED' | 'DROPPED';

interface PipelineUtterance {
  sequenceId: number;
  state: PipelineStage;
  capturedAt: number;
  transcript?: string;
  detectedLanguage?: string;
  translation?: string;
  audioChunks: ArrayBuffer[];
  droppedReason?: string;
  latency?: LatencyMeasurement;
}
```

### Connection Types

```typescript
type ServiceConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected' }
  | { status: 'error'; error: string; retryable: boolean };
```

### Audio Routing Types

```typescript
type AudioRoutingState = 'PASSTHROUGH' | 'MUTED' | 'TTS_PLAYING' | 'BARGE_IN';

type DegradationLevel = 'full' | 'text-only' | 'transcription-only' | 'passthrough';
```

### Echo Cancellation Types

```typescript
type EchoState =
  | { status: 'listening' }
  | { status: 'speaking'; ttsStartedAt: number }
  | { status: 'transitioning'; ttsEndedAt: number };

type EchoEvent =
  | { type: 'tts_start' }
  | { type: 'tts_end' }
  | { type: 'transition_complete' }
  | { type: 'barge_in' };
```

### VAD Types

```typescript
type VADState =
  | { status: 'silence' }
  | { status: 'speech-pending'; startedAt: number }
  | { status: 'speech' }
  | { status: 'silence-pending'; startedAt: number };
```

### Settings Types

```typescript
type LLMProvider = 'openai' | 'anthropic' | 'openrouter';

interface VoiceSettings {
  stability: number;        // 0.0-1.0
  similarityBoost: number;  // 0.0-1.0
  style: number;            // 0.0-1.0
  useSpeakerBoost: boolean;
}
```

### Result Type

```typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

---

## AudioCaptureModule

`src/lib/audio-capture.ts`

Manages microphone access, AudioWorklet setup, VAD, chunking, and noise gating. Runs in the offscreen document.

### Constructor

```typescript
new AudioCaptureModule(config?: Partial<AudioCaptureConfig>)
```

### Configuration

```typescript
interface AudioCaptureConfig {
  sampleRate: 16000;
  channelCount: 1;
  noiseGateThresholdDb: number;   // Default: -40, Ghost Mode: -55
  vadSpeechOnsetMs: number;       // Default: 300
  vadSpeechOffsetMs: number;      // Default: 800
  ghostModeGainDb: number;        // Default: 0, Ghost Mode: +20
}
```

### Methods

| Method | Description |
|--------|-------------|
| `start(): Promise<void>` | Request mic access, set up AudioWorklet, begin capture |
| `stop(): Promise<void>` | Stop all tracks, close AudioContext, reset state |
| `mute(): void` | Mute capture (echo cancellation) |
| `unmute(): void` | Unmute capture |
| `setGhostMode(enabled: boolean): void` | Toggle Ghost Mode (lower threshold, boost gain) |
| `getCurrentLevel(): number` | Get current RMS level in dB for UI meters |
| `getSequenceId(): number` | Get current sequence ID |

### Callbacks

| Callback | Signature | When |
|----------|-----------|------|
| `onAudioChunk` | `(chunk: Int16Array, sequenceId: number) => void` | Every 250ms chunk |
| `onVADStateChange` | `(state: VADState) => void` | VAD state transitions |
| `onSpeechEnd` | `() => void` | VAD detects speech ended |

### Pure Functions

```typescript
computeRmsDb(samples: Int16Array): number
transitionVADState(current, energyDb, thresholdDb, now, onsetDelayMs, offsetDelayMs): VADState
```

---

## STTClient

`src/lib/stt-client.ts`

WebSocket client for ElevenLabs Scribe real-time STT.

### Constructor

```typescript
new STTClient(apiKey: string)
```

### Methods

| Method | Description |
|--------|-------------|
| `connect(config: STTConfig): Promise<void>` | Open WebSocket, send config |
| `disconnect(): Promise<void>` | Send end_of_stream, close WebSocket |
| `sendAudio(chunk: Int16Array): void` | Send PCM audio as binary frame |
| `commit(): void` | Force finalization of current transcript |
| `setSequenceId(id: number): void` | Set current sequence ID for transcript tagging |

### Callbacks

| Callback | Signature |
|----------|-----------|
| `onPartialTranscript` | `(transcript: STTTranscript) => void` |
| `onFinalTranscript` | `(transcript: STTTranscript) => void` |
| `onConnectionStateChange` | `(state: ServiceConnectionState) => void` |

### Pure Functions

```typescript
calculateBackoff(attempt: number, baseDelay?: number, maxDelay?: number): number
```

---

## TranslationEngine

`src/lib/translation-engine.ts`

LLM-based streaming translation with context window and buffering.

### Constructor

```typescript
new TranslationEngine(config?: Partial<TranslationConfig>)
```

### Methods

| Method | Description |
|--------|-------------|
| `translate(transcript: STTTranscript): AsyncGenerator<string>` | Stream translated tokens |
| `setConfig(config: Partial<TranslationConfig>): void` | Update configuration |
| `setLanguagePair(source, target): void` | Change languages mid-session |
| `getContextWindow(): Array<{source, translated}>` | Get current context |
| `destroy(): void` | Clean up timers and buffers |

### Pure Functions

```typescript
addPreservationMarkers(text: string): { markedText: string; markers: Map<string, string> }
removePreservationMarkers(text: string, markers: Map<string, string>): string
splitLongSentence(text: string, maxWords?: number): string[]
```

---

## TTSClient

`src/lib/tts-client.ts`

WebSocket client for ElevenLabs streaming TTS.

### Methods

| Method | Description |
|--------|-------------|
| `connect(config: TTSConfig): Promise<void>` | Open WebSocket, send init config |
| `disconnect(): Promise<void>` | Close WebSocket |
| `sendText(text: string): void` | Stream a text token for synthesis |
| `flush(): void` | Signal end of utterance |
| `cancel(): void` | Cancel current generation (barge-in) |
| `setSequenceId(id: number): void` | Tag audio chunks with sequence ID |
| `updateVoiceSettings(settings: Partial<VoiceSettings>): void` | Update voice parameters |

---

## AudioOutputModule

`src/lib/audio-output.ts`

Routes TTS audio to the meeting via WebRTC track replacement.

### Methods

| Method | Description |
|--------|-------------|
| `initialize(): Promise<void>` | Create AudioContext, GainNode, MediaStreamDestination |
| `playAudio(pcm24k: Int16Array, sequenceId: number): Promise<void>` | Play a PCM chunk |
| `stopPlayback(): void` | Stop all playback immediately |
| `fadeOut(durationMs?: number): void` | Fade out over duration (default 50ms) |
| `getVirtualTrack(): MediaStreamTrack \| null` | Get the virtual track for WebRTC |
| `normalizeVolume(referenceLevel: number): void` | Match user's mic level |
| `isPlaying(): boolean` | Check if audio is currently playing |
| `destroy(): Promise<void>` | Release all audio resources |

---

## EchoCancellationModule

`src/lib/echo-cancellation.ts`

Pure state machine preventing TTS feedback loops.

### Pure Functions

```typescript
transitionEchoState(current: EchoState, event: EchoEvent, ghostMode?: boolean): EchoState
isMicMuted(state: EchoState): boolean
```

### Class Methods

| Method | Description |
|--------|-------------|
| `handleEvent(event: EchoEvent): void` | Process event and apply side effects |
| `setGhostMode(enabled: boolean): void` | Toggle Ghost Mode |
| `reset(): void` | Reset to listening state |
| `destroy(): void` | Clean up timers |

---

## MeetingDetector

`src/lib/meeting-detector.ts`

Platform detection from URL patterns.

### Functions

```typescript
detectPlatform(url: string): MeetingPlatform
getInjectionStrategy(platform: MeetingPlatform): AudioInjectionStrategy
getPlatformName(platform: MeetingPlatform): string
```

---

## VoiceProfileManager

`src/lib/voice-profile.ts`

Voice clone creation, validation, upload, deletion, and preview.

### Pure Functions

```typescript
validateVoiceSample(durationMs: number, averageRmsDb: number): Result<void, VoiceSampleError>
```

### Class Methods

| Method | Description |
|--------|-------------|
| `startRecording(): Promise<void>` | Begin recording voice sample |
| `stopRecording(): Promise<Blob>` | Stop and return audio blob |
| `upload(audioBlob: Blob): Promise<string>` | Upload to ElevenLabs, return voice_id |
| `delete(voiceId: string): Promise<void>` | Delete voice from ElevenLabs |
| `preview(voiceId, text, language): Promise<ArrayBuffer>` | Synthesize test phrase |

---

## LatencyMonitor

`src/lib/latency-monitor.ts`

Per-stage and end-to-end latency tracking.

### Methods

| Method | Description |
|--------|-------------|
| `markCaptureStart(seqId)` | Mark audio capture start |
| `markCaptureEnd(seqId)` | Mark audio capture end |
| `markSTTEnd(seqId)` | Mark STT transcript received |
| `markTranslationStart(seqId)` | Mark translation request sent |
| `markTranslationFirstToken(seqId)` | Mark first translated token |
| `markTTSFirstByte(seqId)` | Mark first TTS audio byte |
| `markPlaybackStart(seqId)` | Mark playback started (finalizes measurement) |
| `getAverageLatency(windowSize?)` | Get rolling average |
| `getLatencyHistory()` | Get all measurements |

---

## SettingsStore

`src/lib/settings-store.ts`

Typed wrapper around `chrome.storage` with AES-GCM-256 encryption.

### Functions

```typescript
getSetting<K>(key: K): Promise<SettingsSchema[K]>
setSetting<K>(key: K, value: SettingsSchema[K]): Promise<void>
getSettings<K>(keys: K[]): Promise<Pick<SettingsSchema, K>>
initializeInstall(): Promise<string>
exportSettings(): Promise<string>
importSettings(json: string): Promise<void>
```

---

## MessageBus

`src/lib/message-bus.ts`

Typed inter-context messaging with sender validation.

### Functions

```typescript
sendMessage<T>(type: T, payload: MessagePayloadMap[T], tabId?: number): void
onMessage<T>(type: T, handler: (payload, message) => void): () => void  // returns unsubscribe
initMessageBus(): void
postToPage(type: string, payload: unknown): void
onPageMessage(type: string, handler: (payload) => void): () => void
```

---

## DebugLog

`src/lib/debug-log.ts`

Circular buffer for diagnostics. Never logs transcript content or audio data.

### Functions

```typescript
log(level, category, message, metadata?): void
getEntries(): DebugLogEntry[]
getFilteredEntries(category?, level?): DebugLogEntry[]
exportLog(): string
clearLog(): void
getBufferSize(): number
```
