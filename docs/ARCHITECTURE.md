# VoiceBridge — System Architecture

> A complete technical reference for the real-time voice translation pipeline.
> Every component, every state machine, every data flow, every design decision — documented.

## Table of Contents

- [System Overview](#system-overview)
- [Execution Contexts](#execution-contexts)
- [Data Flow — Single Utterance](#data-flow--single-utterance)
- [Pipeline Orchestrator](#pipeline-orchestrator)
- [Audio Routing State Machine](#audio-routing-state-machine)
- [Echo Cancellation State Machine](#echo-cancellation-state-machine)
- [VAD State Machine](#vad-state-machine)
- [Audio Format Pipeline](#audio-format-pipeline)
- [Meeting Platform Adapters](#meeting-platform-adapters)
- [Degradation Cascade](#degradation-cascade)
- [Network Resilience](#network-resilience)
- [Security Model](#security-model)
- [Latency Budget](#latency-budget)
- [Memory Management](#memory-management)

---

## System Overview

VoiceBridge is a Manifest V3 Chrome Extension operating as a five-stage streaming pipeline:

```
Audio Capture → STT → Translation → TTS → Audio Output
```

The extension runs across five Chrome execution contexts, coordinated through a typed message bus:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Chrome Extension (Manifest V3)                    │
│                                                                          │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────────────┐     │
│  │   Service     │  │    Offscreen      │  │    Content Script       │     │
│  │   Worker      │  │    Document       │  │    (per meeting tab)    │     │
│  │              │  │                    │  │                        │     │
│  │  Orchestrator │  │  Pipeline Host    │  │  Widget + Platform     │     │
│  │  + Settings   │  │  WebSockets       │  │  Adapter + Audio       │     │
│  │  + Alarms     │  │  Audio Processing │  │  Bridge Receiver       │     │
│  └──────┬───────┘  └────────┬─────────┘  └───────────┬────────────┘     │
│         │                    │                         │                  │
│         │    chrome.runtime  │    MessageChannel       │                  │
│         │◄──────────────────►│◄───────────────────────►│                  │
│                                                                          │
│  ┌──────────────┐  ┌──────────────────┐                                  │
│  │    Popup      │  │    Side Panel     │                                  │
│  │  Controls     │  │  Live Transcript  │                                  │
│  └──────────────┘  └──────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────┘
         │                    │                         │
         ▼                    ▼                         ▼
┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────┐
│ ElevenLabs STT  │  │ ElevenLabs TTS   │  │ Meeting Platform       │
│ (Scribe)        │  │ (Streaming)      │  │ (WebRTC)               │
│ wss://          │  │ wss://           │  │ RTCPeerConnection      │
└─────────────────┘  └──────────────────┘  └────────────────────────┘
         │
         ▼
┌─────────────────┐
│ LLM API         │
│ (Translation)   │
│ OpenAI/Anthropic│
│ /OpenRouter     │
└─────────────────┘
```

### Key Design Decisions

1. **Offscreen document as pipeline host** — WebSocket connections and AudioContext live here because the service worker is ephemeral (~30s idle timeout). The offscreen document provides a persistent DOM context.

2. **Vanilla TypeScript, no framework** — All UI is vanilla TS + DOM manipulation. CSS custom properties handle theming. Bundle size matters for Chrome Web Store.

3. **Discriminated unions for all state** — Every state machine uses TypeScript discriminated unions with exhaustive switch checks. No optional field ambiguity.

4. **Shadow DOM for widget isolation** — The floating widget injects into meeting pages via Shadow DOM to prevent style leakage in both directions.

5. **Token-by-token TTS streaming** — Translation output streams to TTS token-by-token to minimize time-to-first-audio-byte.

6. **MessageChannel for audio data** — Audio chunks transfer between offscreen and content script via MessageChannel with Transferable ArrayBuffers (zero-copy), bypassing the service worker.

---

## Execution Contexts

| Context | Lifecycle | Responsibilities |
|---------|-----------|-----------------|
| Service Worker | Ephemeral (~30s idle) | Session orchestration, meeting detection, settings, alarm scheduling, offscreen lifecycle, MessageChannel broker |
| Offscreen Document | Persistent (during session) | WebSocket connections (STT/TTS), audio capture/processing, translation, echo cancellation, pipeline orchestration, latency monitoring |
| Content Script | Per-tab (meeting pages) | Floating widget, platform adapter, WebRTC audio injection, AudioBridge receiver |
| Popup | On-demand | Controls, language selection, status display, demo limit UI |
| Side Panel | On-demand | Live transcript view, search, export |

---

## Data Flow — Single Utterance

```
1. Microphone captures Float32 audio at device native rate
2. AudioContext resamples to 16kHz
3. AudioWorklet converts Float32 → Int16 PCM (dedicated audio thread)
4. Ring buffer accumulates 250ms chunks (4000 samples)
5. VAD analyzes energy per 10ms frame
6. On speech detection, chunks stream to STT via WebSocket (binary frames)
7. STT returns partial transcripts (displayed in side panel with italic styling)
8. STT returns final transcript on speech-end commit
9. Translation Engine sends transcript to LLM with context window
10. LLM streams translated tokens back
11. Each token forwards to TTS WebSocket immediately
12. TTS returns PCM Int16 audio at 24kHz
13. Audio Output converts Int16 → Float32, resamples 24kHz → 48kHz
14. Audio routes through GainNode → MediaStreamDestination
15. Virtual MediaStreamTrack transfers via MessageChannel to content script
16. Platform Adapter injects virtual track into RTCPeerConnection via replaceTrack()
17. Meeting participants hear translated audio via WebRTC (Opus codec, 48kHz)
```

During this entire flow, the echo cancellation state machine mutes the user's mic in the meeting to prevent double-voice.

---

## Pipeline Orchestrator

The PipelineOrchestrator is the central coordinator in the offscreen document. It tracks every utterance through its lifecycle:

```
CAPTURED → TRANSCRIBED → TRANSLATED → SYNTHESIZED → PLAYED
                                                        ↓
                              (any stage can fail) → DROPPED
```

### Utterance Tracking

Each utterance gets a monotonically increasing sequence ID (1, 2, 3, ..., N per session). The orchestrator maintains a bounded map of active utterances (max 10), evicting completed ones older than 30 seconds.

### Strict Playback Ordering

Utterance N+1 never plays before utterance N reaches PLAYED or DROPPED. This prevents out-of-order translated speech.

### Backpressure

If more than 3 utterances are queued (CAPTURED or TRANSCRIBED), the oldest unprocessed ones are dropped. This keeps the pipeline real-time — we'd rather skip a sentence than fall behind.

### Per-Stage Timeouts

| Stage | Timeout | On Timeout |
|-------|---------|------------|
| STT | 5 seconds | Drop utterance, continue |
| Translation | 3 seconds | Drop utterance, continue |
| TTS | 3 seconds | Drop utterance, continue |

Failed utterances never block the pipeline.

---

## Audio Routing State Machine

Controls what audio the meeting hears at any moment:

```
                    session_start
    PASSTHROUGH ──────────────────► MUTED
         ▲                            │
         │ session_stop               │ tts_start
         │                            ▼
         ├──────────────────── TTS_PLAYING
         │ session_stop               │
         │                            │ barge_in
         │                            ▼
         └──────────────────── BARGE_IN
                session_stop     │
                                 │ vad_speech_end
                                 ▼
                               MUTED
```

| State | Meeting Hears | Mic Status | When |
|-------|--------------|------------|------|
| PASSTHROUGH | Original mic audio | Active, flowing to meeting | Translation off |
| MUTED | Silence | Captured for STT, not sent to meeting | Between utterances |
| TTS_PLAYING | Translated TTS audio | Muted in meeting | TTS playback active |
| BARGE_IN | Original mic (TTS fading) | Active, flowing to meeting | User interrupts TTS |

Transitions complete within 50ms. No audible gaps. No double-voice.

---

## Echo Cancellation State Machine

Prevents TTS output from being re-captured by the microphone:

```
    LISTENING ──── tts_start ────► SPEAKING ──── tts_end ────► TRANSITIONING
        ▲                              │                            │
        │                         barge_in                    200ms elapsed
        │                              │                            │
        └──────────────────────────────┘                            │
        └───────────────────────────────────────────────────────────┘
```

| State | Mic | TTS | Duration |
|-------|-----|-----|----------|
| LISTENING | Active | Silent | Indefinite |
| SPEAKING | Muted | Playing | Until TTS ends |
| TRANSITIONING | Muted | Silent | 200ms (echo tail dissipation) |

**Ghost Mode override**: No barge-in detection. Mic stays fully muted during SPEAKING (whisper input too sensitive for barge-in discrimination).

---

## VAD State Machine

Energy-based Voice Activity Detection with hysteresis:

```
    SILENCE ──── energy > threshold ────► SPEECH_PENDING
       ▲                                       │
       │ energy drops                     300ms elapsed
       │                                       │
       │                                       ▼
       │                                    SPEECH
       │                                       │
       │                                  energy < threshold
       │                                       │
       │                                       ▼
       └──── 800ms elapsed ──────── SILENCE_PENDING
                                          │
                                     energy rises
                                          │
                                          ▼
                                       SPEECH
```

- **Onset delay (300ms)**: Prevents triggering on transient sounds
- **Offset delay (800ms)**: Prevents cutting off natural pauses mid-sentence
- **Noise gate**: Configurable threshold (default -40dB, Ghost Mode -55dB)

---

## Audio Format Pipeline

```
Microphone (device native, typically 44.1/48kHz Float32)
    │
    ▼ AudioContext({ sampleRate: 16000 })
    │  Browser resamples automatically
    │
AudioWorklet (Float32 → Int16 conversion)
    │  pcm16[i] = clamp(float32[i], -1, 1) * (float32[i] < 0 ? 0x8000 : 0x7FFF)
    │
    ▼ Ring buffer accumulates 4000 samples (250ms)
    │
STT WebSocket (PCM Int16, 16kHz, mono, 8000 bytes/chunk)
    │
    ▼ transcript.final
    │
Translation Engine (text tokens, streaming)
    │
    ▼ translated tokens
    │
TTS WebSocket (PCM Int16, 24kHz, mono)
    │
    ▼ Int16 → Float32: sample / 32768.0
    │
AudioContext({ sampleRate: 48000 })
    │  Browser resamples 24kHz → 48kHz via sinc interpolation
    │
GainNode (volume normalization)
    │
MediaStreamDestination → virtual MediaStreamTrack
    │
    ▼ MessageChannel (Transferable, zero-copy)
    │
Content Script → Platform Adapter → replaceTrack()
    │
WebRTC (Opus codec, 48kHz, 48kbps)
```

---

## Meeting Platform Adapters

Each meeting platform has a different WebRTC implementation. VoiceBridge uses platform-specific adapters:

### Google Meet
Intercepts `navigator.mediaDevices.getUserMedia` before the page loads via a main-world script injected at `document_start`. Stores the original audio track, replaces it with the virtual track when translation starts.

### Microsoft Teams / Discord
Monitors the `RTCPeerConnection` constructor in the main world. Captures created peer connections. Uses `RTCRtpSender.replaceTrack()` on the audio sender to inject the virtual track.

### Zoom Web
Zoom's custom media stack restricts `replaceTrack`. Falls back to `chrome.tabCapture.capture()` to get the tab's audio stream, creates an AudioContext mixing node that combines TTS audio with the tab output.

### Generic (Force Enable)
For unknown WebRTC apps. Monitors `RTCPeerConnection` constructor and attempts `replaceTrack()` on any detected audio sender.

→ [Detailed platform adapter documentation](PLATFORM-ADAPTERS.md)

---

## Degradation Cascade

When services fail, VoiceBridge degrades gracefully:

```
FULL PIPELINE ──── TTS fails ────► TEXT-ONLY ──── LLM fails ────► TRANSCRIPTION-ONLY ──── STT fails ────► PASSTHROUGH
     ▲                                  ▲                                ▲                                      │
     │                                  │                                │                                      │
     └── TTS recovers ─────────────────┘── LLM recovers ───────────────┘── STT recovers ──────────────────────┘
```

| Level | What Works | What the User Sees |
|-------|-----------|-------------------|
| Full | STT + Translation + TTS + Audio Output | Translated voice in meeting |
| Text-Only | STT + Translation | Translated text in side panel, original mic in meeting |
| Transcription-Only | STT | Original transcript in side panel, original mic in meeting |
| Passthrough | Nothing | Original mic in meeting, no processing |

Degradation always follows the cascade order — never skips levels. Recovery automatically upgrades to the highest available level within 5 seconds.

**The user's original microphone is always available.** VoiceBridge never blocks you from speaking.

---

## Network Resilience

### WebSocket Reconnection

Both STT and TTS WebSocket connections use exponential backoff:

```
Attempt 0: 500ms
Attempt 1: 1000ms
Attempt 2: 2000ms
Attempt 3: 4000ms
Attempt 4: 8000ms (capped at 10000ms)
```

If all 5 attempts fail, wait 30 seconds, then try 5 more (second chance). If that also fails, pause the session.

### Audio Buffering During Disconnection

- **STT**: Buffers up to 10 seconds of audio (160,000 samples at 16kHz). Replays on reconnection.
- **TTS**: Buffers pending text tokens. Replays on reconnection.
- **Audio Capture**: Continues capturing regardless of connection state. No speech is lost during brief outages.

---

## Security Model

### API Key Protection

```
User enters key → PBKDF2(extensionId + installSalt, 100K iterations, SHA-256)
                → AES-GCM-256 encrypt
                → chrome.storage.local

Key needed → chrome.storage.local
           → AES-GCM-256 decrypt
           → use in offscreen/service-worker ONLY
           → NEVER sent to content script
```

### Trust Boundaries

| Context | Trust Level | API Keys | Audio |
|---------|-------------|----------|-------|
| Service Worker | High | Yes (encrypted) | No |
| Offscreen Document | High | Yes (decrypted for WebSocket) | Yes |
| Content Script | Medium | No | Yes (WebRTC injection only) |
| Popup / Side Panel | Medium | No | No |
| Meeting Page | Low | No | No (receives virtual track only) |

### Content Security Policy

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'none'"
}
```

### Message Validation

Every `chrome.runtime.onMessage` handler validates `sender.id === chrome.runtime.id`. Content script ↔ page messages use `window.postMessage` with origin check and `source: 'voicebridge'` marker.

---

## Latency Budget

Target: under 2000ms end-to-end.

| Stage | Budget | Measurement |
|-------|--------|-------------|
| Audio capture + chunking | 250ms | Fixed (chunk size) |
| STT (speech-end → transcript) | 500ms | WebSocket round-trip |
| Translation (transcript → first token) | 300ms | LLM streaming start |
| TTS (text → first audio byte) | 300ms | WebSocket round-trip |
| Audio routing + buffer | 100ms | Fixed overhead |
| Headroom | 550ms | Network variance |
| **Total** | **< 2000ms** | End-to-end |

If latency exceeds 3000ms for 5 consecutive utterances, the extension alerts the user.

---

## Memory Management

| Buffer | Size | Purpose |
|--------|------|---------|
| AudioWorklet ring buffer | 4000 samples (250ms) | Accumulate before sending to STT |
| STT reconnection queue | 10s of audio (160K samples) | Buffer during disconnections |
| TTS playback buffer | 100ms | Prevent audio underruns |
| Pipeline utterance queue | Max 3 unprocessed | Backpressure management |
| Active utterance map | Max 10 entries | Lifecycle tracking |
| Transcript store | Max 500 entries | Side panel display |
| Debug log | 200 entries (circular) | Diagnostics |

Audio buffers are cleared immediately after sending. `Transferable` objects used for all cross-context transfers. `MediaStream` tracks stopped on session end. `AudioContext` closed when not in use.

Maximum memory footprint: under 200MB across all extension contexts during active session.
