# VoiceBridge

**Speak any language. In your own voice.**

---

VoiceBridge is a Chrome Extension that does something no one thought possible in a browser tab: it listens to you speak, translates your words in real-time, and speaks them aloud in your own cloned voice — in any language — directly into your meeting. Other participants hear *you*, fluent in their language, with under two seconds of delay.

This isn't a transcript. This isn't a subtitle. This is *you*, speaking Japanese. Speaking Arabic. Speaking Portuguese. In your voice. Live.

---

## The Pipeline

```
Your voice → Transcription → Translation → Your cloned voice → Their ears
   16kHz         500ms           300ms          300ms           48kHz
```

Five stages. Under two seconds. Zero compromise.

| Stage | Technology | Latency |
|-------|-----------|---------|
| Capture | Web Audio API + AudioWorklet | 250ms |
| Transcribe | ElevenLabs Scribe (real-time STT) | 500ms |
| Translate | LLM via OpenAI / Anthropic / OpenRouter | 300ms |
| Synthesize | ElevenLabs Streaming TTS | 300ms |
| Deliver | WebRTC track injection | 100ms |

---

## Features

### Real-Time Voice Translation
Speak naturally. Your words are transcribed, translated, and re-spoken in your cloned voice — all while you're still finishing your sentence. The pipeline streams token-by-token. No waiting for complete sentences.

### Your Voice, Every Language
Record 30 seconds of your voice. VoiceBridge clones it. Now you speak 90+ languages and it still sounds like you. Your colleagues won't know the difference.

### Works Where You Work
Google Meet. Zoom. Microsoft Teams. Discord. VoiceBridge injects directly into the meeting's audio stream. No extra software. No virtual audio devices. No configuration.

### Ghost Mode
Whisper. Mouth words. Barely make a sound. VoiceBridge amplifies your whisper, transcribes it, translates it, and speaks at full volume in the meeting. You're silent. Your voice isn't.

### Language Roulette
One sentence. Ten languages. Your voice. In under 45 seconds. The demo feature that stops rooms cold. English → Japanese → Spanish → Arabic → French → Mandarin → German → Korean → Portuguese → Hindi. Back-to-back. No gaps. Pure magic.

### Nothing Design Language
Every pixel earns its place. OLED blacks. Monospace labels. Mechanical toggles. Segmented progress bars. The UI of a precision instrument, not a toy. Dark mode default. Light mode for the brave.

---

## Try It — Free

VoiceBridge ships with a built-in demo: **2 minutes of voice time, every 24 hours.** Only your speaking time counts — silence and pauses are free. No account. No signup. No credit card.

Want unlimited? Paste your own ElevenLabs API key. Hackathon attendees get the Creator plan free at [hacks.elevenlabs.io](https://hacks.elevenlabs.io/hackathons/4).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chrome Extension (Manifest V3)                 │
├──────────────┬──────────────┬────────────┬──────────┬───────────┤
│   Service    │   Offscreen  │  Content   │  Popup   │   Side    │
│   Worker     │   Document   │  Script    │          │   Panel   │
│              │              │            │          │           │
│ Orchestrator │ Pipeline Host│ Widget +   │ Controls │ Live      │
│ + Settings   │ WebSockets   │ Audio      │ + Status │ Transcript│
│              │ + Audio      │ Injection  │          │           │
└──────────────┴──────────────┴────────────┴──────────┴───────────┘
```

- **Service Worker**: Orchestrates session lifecycle. Ephemeral by design.
- **Offscreen Document**: Persistent home for WebSocket connections and audio processing.
- **Content Script**: Injects the floating widget. Handles WebRTC audio routing.
- **Popup**: Language selection, toggle, status at a glance.
- **Side Panel**: Live transcript — original and translated, side by side.

---

## Supported Platforms

| Platform | Strategy | Status |
|----------|----------|--------|
| Google Meet | getUserMedia intercept | ✓ Full support |
| Microsoft Teams | RTCPeerConnection replaceTrack | ✓ Full support |
| Discord | RTCPeerConnection replaceTrack | ✓ Full support |
| Zoom Web | tabCapture fallback | ✓ Full support |
| Any WebRTC app | Generic replaceTrack | ✓ Force Enable |

---

## Supported Languages

**90+ input languages** via ElevenLabs Scribe. **32+ output languages** via ElevenLabs Multilingual v2. Any-to-any translation via LLM — no artificial restrictions.

Auto-detect is default. The extension figures out what you're speaking.

---

## Quick Start

1. Install the extension
2. Enter your ElevenLabs API key (or use the free demo)
3. Record 30 seconds of your voice
4. Pick your languages
5. Join a meeting. Toggle on. Speak.

That's it. Five steps. You're multilingual.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (strict) | Type safety across 5 execution contexts |
| UI | Vanilla DOM + CSS Custom Properties | Bundle size. No framework tax. |
| Build | Vite | Fast. Tree-shakes aggressively. |
| STT | ElevenLabs Scribe | Real-time WebSocket streaming |
| TTS | ElevenLabs Multilingual v2 | Voice cloning + streaming |
| Translation | OpenAI / Anthropic / OpenRouter | Streaming, contextual, 200+ models via OpenRouter |
| Audio | Web Audio API + AudioWorklet | Zero main-thread blocking |
| Icons | Lucide (thin) | Monoline. Nothing-compatible. |
| Tests | Vitest + fast-check | Property-based correctness |

No React. No Tailwind. No Lodash. No state management library. Just TypeScript and the platform.

---

## Design Philosophy

> "Design is not just what it looks like and feels like. Design is how it works."

VoiceBridge follows the Nothing design language:

- **Subtract, don't add.** Every element earns its pixel.
- **Monochrome is the canvas.** Color is an event, not a default.
- **Type does the heavy lifting.** Space Grotesk. Space Mono. Doto for hero moments.
- **Industrial warmth.** Technical and precise, never cold.
- **Three layers only.** Primary → Secondary → Tertiary. If two things compete, one dies.

---

## Privacy

- Audio is streamed, never stored
- Transcripts exist only in memory, cleared on session end
- API keys encrypted with AES-GCM-256
- No analytics. No tracking. No telemetry.
- Content scripts never touch your API keys
- Panic button (Ctrl+Shift+X) kills everything instantly

---

## Development

```bash
# Install dependencies
npm install

# Development build with hot reload
npm run dev

# Production build
npm run build

# Run tests
npm run test

# Type check
npm run typecheck
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Alt+T | Toggle translation |
| Ctrl+Space | Push-to-translate (hold) |
| Ctrl+Shift+X | Panic stop — kill everything |
| Alt+G | Toggle Ghost Mode |
| Alt+R | Language Roulette |

---

## License

MIT

---

<p align="center">
  <em>Built for <a href="https://hacks.elevenlabs.io/hackathons/4">ElevenLabs Hackathon</a> × Kiro</em>
</p>
