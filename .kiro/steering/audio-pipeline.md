# Audio Pipeline — Real-Time Streaming Standards

This project processes real-time audio through a multi-stage pipeline. Follow these rules for all audio-related code.

## Pipeline Architecture

```
┌─────────────┐    ┌───────────┐    ┌─────────────┐    ┌───────────┐    ┌──────────────┐
│ Mic Capture  │───▶│ STT       │───▶│ Translation │───▶│ TTS       │───▶│ Audio Output  │
│ (16kHz PCM)  │    │ (Scribe)  │    │ (LLM)      │    │ (Stream)  │    │ (48kHz WebRTC)│
└─────────────┘    └───────────┘    └─────────────┘    └───────────┘    └──────────────┘
       │                                                                        │
       └────────────── Echo Cancellation State Machine ─────────────────────────┘
```

## Audio Format Specifications

| Stage | Format | Sample Rate | Channels | Bit Depth |
|-------|--------|-------------|----------|-----------|
| Mic capture (Web Audio) | Float32 | Device native | Mono | 32-bit float |
| STT input | PCM Int16 | 16,000 Hz | Mono | 16-bit signed |
| TTS output | PCM Int16 | 24,000 Hz | Mono | 16-bit signed |
| Meeting output (WebRTC) | Float32 → Opus | 48,000 Hz | Mono | 32-bit float |

## AudioWorklet Rules

All audio processing MUST happen in an AudioWorklet to avoid main thread blocking:

```typescript
// audio-processor.worklet.ts
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0][0]; // Mono channel
    if (!input) return true;
    
    // Convert Float32 [-1.0, 1.0] to Int16 [-32768, 32767]
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Post to main thread
    this.port.postMessage({ type: 'audio', buffer: pcm16.buffer }, [pcm16.buffer]);
    return true;
  }
}
```

Rules:
- Never allocate in the `process()` method hot path if avoidable
- Use `Transferable` objects (ArrayBuffer transfer) for zero-copy messaging
- Return `true` to keep the processor alive, `false` to disconnect
- Register with: `registerProcessor('audio-processor', AudioProcessor)`

## Chunking Strategy

- Buffer 250ms of audio before sending to STT (4000 samples at 16kHz)
- This balances latency (smaller = faster) vs overhead (larger = fewer messages)
- Use a ring buffer to accumulate samples until chunk threshold is met
- Never send partial chunks — always exactly 250ms worth

```typescript
const CHUNK_SIZE = 4000; // 250ms at 16kHz
let buffer = new Int16Array(CHUNK_SIZE);
let bufferOffset = 0;

function onAudioData(samples: Int16Array) {
  let samplesOffset = 0;
  while (samplesOffset < samples.length) {
    const remaining = CHUNK_SIZE - bufferOffset;
    const toCopy = Math.min(remaining, samples.length - samplesOffset);
    buffer.set(samples.subarray(samplesOffset, samplesOffset + toCopy), bufferOffset);
    bufferOffset += toCopy;
    samplesOffset += toCopy;
    
    if (bufferOffset === CHUNK_SIZE) {
      sendToSTT(buffer);
      buffer = new Int16Array(CHUNK_SIZE);
      bufferOffset = 0;
    }
  }
}
```

## Sample Rate Conversion

When converting TTS output (24kHz) to WebRTC output (48kHz):

- Use Web Audio API's built-in resampling via AudioContext sampleRate
- Create AudioContext at 48000Hz, decode 24kHz PCM into it
- The browser handles sinc interpolation automatically
- Do NOT implement manual resampling — browser's is higher quality

```typescript
const ctx = new AudioContext({ sampleRate: 48000 });
const audioBuffer = ctx.createBuffer(1, samples.length * 2, 48000);
// Browser resamples when you set channel data from different rate source
```

## Voice Activity Detection (VAD)

Energy-based VAD with hysteresis:

```typescript
interface VADConfig {
  noiseGateThreshold: number;  // Default: -40dB
  speechOnsetDelay: number;    // 300ms — avoid triggering on transients
  speechOffsetDelay: number;   // 800ms — avoid cutting off pauses
}

// States: SILENCE → SPEECH_PENDING → SPEECH → SILENCE_PENDING → SILENCE
```

- Calculate RMS energy per frame (10ms windows)
- Convert to dB: `20 * Math.log10(rms)`
- Compare against threshold with hysteresis delays
- On SPEECH → SILENCE transition: signal STT to commit

## Echo Cancellation State Machine

```
┌──────────┐  TTS starts   ┌─────────────┐  200ms elapsed  ┌──────────┐
│ LISTENING │──────────────▶│  SPEAKING   │────────────────▶│TRANSITION│
│ (mic ON)  │◀──────────────│ (mic MUTED) │                 │(mic OFF) │
└──────────┘  barge-in      └─────────────┘                 └──────────┘
      ▲                                                           │
      └───────────────────────────────────────────────────────────┘
                              200ms elapsed (transition complete)
```

Rules:
- LISTENING: Mic active, no TTS playing. Normal operation.
- SPEAKING: TTS audio playing, mic muted. Prevents feedback loop.
- TRANSITIONING: 200ms buffer after TTS ends before re-enabling mic (echo tail).
- Barge-in: If VAD detects speech during SPEAKING, immediately stop TTS, go to LISTENING.

## Barge-In Handling

1. Detect barge-in via VAD activation during SPEAKING state
2. Fade out TTS over 50ms (not instant cut — avoids click)
3. Send flush/cancel to TTS WebSocket
4. Discard all queued TTS audio segments
5. Switch to LISTENING within 100ms total
6. Resume normal STT pipeline

## Pipeline Ordering

Every utterance gets a monotonically increasing sequence ID:

```typescript
interface PipelineUtterance {
  sequenceId: number;
  state: 'CAPTURED' | 'TRANSCRIBED' | 'TRANSLATED' | 'SYNTHESIZED' | 'PLAYED' | 'DROPPED';
  capturedAt: number;
  transcript?: string;
  translation?: string;
  audioChunks?: ArrayBuffer[];
}
```

Rules:
- Process in order. Never play utterance N+1 before N.
- If utterance N fails at any stage, mark as DROPPED and continue with N+1.
- If pipeline has >3 queued utterances (backpressure), drop oldest unprocessed ones.
- Log all drops for diagnostics.

## Latency Budget

Total target: < 2000ms end-to-end

| Stage | Budget | Measurement |
|-------|--------|-------------|
| Audio capture + chunking | 250ms | Fixed (chunk size) |
| STT (speech-end to transcript) | 500ms | WebSocket round-trip |
| Translation (transcript to first token) | 300ms | LLM streaming start |
| TTS (text to first audio byte) | 300ms | WebSocket round-trip |
| Audio routing + buffer | 100ms | Fixed overhead |
| Headroom | 550ms | Network variance |

Measure each stage independently. Display in latency monitor.

## WebRTC Audio Injection

To replace the user's mic track in a meeting:

```typescript
// Get the RTCPeerConnection from the page
// Replace the audio track with our virtual source
const virtualStream = audioContext.createMediaStreamDestination();
const virtualTrack = virtualStream.stream.getAudioTracks()[0];

// Find the sender for the audio track
const sender = peerConnection.getSenders().find(s => s.track?.kind === 'audio');
await sender.replaceTrack(virtualTrack);

// To restore original:
await sender.replaceTrack(originalMicTrack);
```

Platform-specific notes:
- Google Meet: Intercept `getUserMedia` before page loads, provide virtual stream
- Zoom Web: Uses custom media stack, may need `tabCapture` fallback
- Teams Web: Standard `replaceTrack` on RTCPeerConnection works
- Discord: Standard `replaceTrack` works

## Memory Management

- Release MediaStream tracks when session ends: `track.stop()`
- Close AudioContext when not in use: `ctx.close()`
- Clear audio buffers immediately after sending
- Use `Transferable` objects to avoid copying large audio buffers
- Limit transcript store to 500 entries max
