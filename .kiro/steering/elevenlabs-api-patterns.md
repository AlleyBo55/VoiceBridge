# ElevenLabs API — Integration Patterns

This project uses ElevenLabs for real-time STT (Scribe), streaming TTS, and voice cloning. Follow these patterns for all ElevenLabs API interactions.

## SDK & Authentication

Use `@elevenlabs/elevenlabs-js` for REST calls. Use raw WebSocket for real-time streaming.

```typescript
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const client = new ElevenLabsClient({
  apiKey: decryptedApiKey // Never hardcode, always from encrypted storage
});
```

For WebSocket connections, pass API key via header or token:
- STT: Use single-use token from `POST /v1/speech-to-text/stream/token`
- TTS: Pass `xi-api-key` in WebSocket URL query param or initial message

## Real-Time Speech-to-Text (Scribe)

### Connection

```typescript
const ws = new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/stream');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "config",
    encoding: "pcm_16000",
    language_code: sourceLanguage, // BCP 47 or "auto"
    model: "scribe_v1"
  }));
};
```

### Sending Audio

- Send PCM Int16 audio as binary WebSocket frames
- Chunk size: 250ms (4000 samples at 16kHz = 8000 bytes)
- No additional encoding — raw binary

```typescript
function sendAudioChunk(pcm16: Int16Array) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(pcm16.buffer);
  }
}
```

### Receiving Transcripts

```typescript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case "transcript.partial":
      // Display in UI with italic/pulsing style
      updatePartialTranscript(msg.text);
      break;
    case "transcript.final":
      // Forward to translation engine immediately
      onFinalTranscript(msg.text, msg.language);
      break;
    case "error":
      handleSTTError(msg);
      break;
  }
};
```

### Commit (Force Finalization)

Send when VAD detects end of utterance:

```typescript
ws.send(JSON.stringify({ type: "commit" }));
```

### Token Management

Single-use tokens expire. Obtain fresh token per session:

```typescript
async function getSTTToken(): Promise<string> {
  const response = await client.speechToText.getRealtimeToken();
  return response.token;
}
```

## Streaming Text-to-Speech

### WebSocket Connection

```typescript
const ttsWs = new WebSocket(
  `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_multilingual_v2`
);

ttsWs.onopen = () => {
  // Send initial config
  ttsWs.send(JSON.stringify({
    text: " ", // Space to initialize
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.3,
      use_speaker_boost: true
    },
    xi_api_key: apiKey,
    output_format: "pcm_24000"
  }));
};
```

### Streaming Text Input

Send text token-by-token as it arrives from translation:

```typescript
function sendTextChunk(text: string) {
  ttsWs.send(JSON.stringify({
    text: text,
    try_trigger_generation: true
  }));
}

// When utterance is complete, flush:
function flushTTS() {
  ttsWs.send(JSON.stringify({
    text: "",
    flush: true
  }));
}
```

### Receiving Audio

```typescript
ttsWs.onmessage = (event) => {
  if (event.data instanceof Blob) {
    // Binary audio data — PCM 24kHz Int16
    event.data.arrayBuffer().then(buffer => {
      const pcm = new Int16Array(buffer);
      routeToAudioOutput(pcm);
    });
  } else {
    const msg = JSON.parse(event.data);
    if (msg.audio) {
      // Base64 encoded audio
      const audioBytes = atob(msg.audio);
      // Process...
    }
  }
};
```

### Cancel/Interrupt

On barge-in, stop current generation:

```typescript
function cancelTTS() {
  ttsWs.send(JSON.stringify({
    text: "",
    flush: true  // Flush forces output of any buffered audio then stops
  }));
  // Discard any queued audio locally
  audioQueue.clear();
}
```

## Voice Cloning

### Create Voice Profile

```typescript
async function createVoiceProfile(audioBlob: Blob, userId: string): Promise<string> {
  const formData = new FormData();
  formData.append('files', audioBlob, 'voice-sample.wav');
  formData.append('name', `VoiceBridge-${userId}`);
  formData.append('labels', JSON.stringify({ source: 'voicebridge' }));
  
  const response = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: formData
  });
  
  const { voice_id } = await response.json();
  return voice_id;
}
```

### Delete Voice Profile

```typescript
async function deleteVoiceProfile(voiceId: string): Promise<void> {
  await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': apiKey }
  });
}
```

### Preview Voice

```typescript
async function previewVoice(voiceId: string, text: string, language: string): Promise<ArrayBuffer> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  return response.arrayBuffer();
}
```

## Quota & Usage

### Check Subscription

```typescript
async function getUsage(): Promise<{ used: number; limit: number }> {
  const sub = await client.user.getSubscription();
  return {
    used: sub.character_count,
    limit: sub.character_limit
  };
}
```

### Usage Thresholds

- 80% used → yellow warning in UI
- 95% used → urgent red warning, suggest ending session
- 100% used → stop TTS, continue in text-only mode

## Supported Languages

### Dynamic Language Fetching

Do NOT hardcode language lists. Fetch from API:

```typescript
async function getSupportedLanguages() {
  // For TTS: check model capabilities
  const models = await client.models.list();
  const multilingualModel = models.find(m => m.model_id === 'eleven_multilingual_v2');
  const ttsLanguages = multilingualModel?.languages || [];
  
  // For STT: Scribe supports 90+ languages
  // Use the full list from ElevenLabs docs, cached locally
  return { ttsLanguages, sttLanguages };
}
```

Cache the language list in `chrome.storage.local` with a 24-hour TTL.

## Error Handling

| HTTP Code | Meaning | Action |
|-----------|---------|--------|
| 401 | Invalid API key | Prompt re-entry in settings |
| 402 | Quota exhausted | Switch to text-only mode |
| 429 | Rate limited | Queue + retry after `Retry-After` |
| 500+ | Server error | Retry with exponential backoff |

### WebSocket Reconnection

```typescript
function reconnectWithBackoff(createConnection: () => WebSocket, maxAttempts = 5) {
  let attempt = 0;
  const baseDelay = 500;
  const maxDelay = 10000;
  
  function tryConnect() {
    attempt++;
    const ws = createConnection();
    
    ws.onerror = () => {
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        setTimeout(tryConnect, delay);
      } else {
        notifyUserConnectionFailed();
      }
    };
    
    ws.onopen = () => { attempt = 0; }; // Reset on success
  }
  
  tryConnect();
}
```

## Performance Rules

- Never buffer more than 10 seconds of audio in memory
- Close WebSocket connections when session ends — don't leave them idle
- Use `output_format: "pcm_24000"` for TTS (lowest latency, no decode overhead)
- Send text to TTS incrementally (token-by-token) — don't wait for full translation
- Heartbeat ping every 15 seconds to detect silent disconnections
