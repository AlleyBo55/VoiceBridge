<p align="center">
  <img src="src/icons/icon.svg" width="80" height="80" alt="VoiceBridge">
</p>

<h1 align="center">VoiceBridge</h1>

<p align="center">
  <strong>Speak any language. In your own voice.</strong>
</p>

<p align="center">
  <em>The world's first real-time voice translation engine that runs inside a browser tab.</em>
</p>

<p align="center">
  <a href="#the-demo">Watch Demo</a> · <a href="docs/ARCHITECTURE.md">Architecture</a> · <a href="docs/GETTING-STARTED.md">Get Started</a> · <a href="docs/API-REFERENCE.md">API Reference</a>
</p>

---

## One More Thing.

You're in a meeting with colleagues in Tokyo, clients in São Paulo, and partners in Berlin. You speak English. They hear you — fluently, naturally, instantly — in Japanese, Portuguese, and German. In *your* voice.

Not a robotic translation. Not a subtitle at the bottom of the screen. Not a five-second delay while some server thinks about it.

**You. Speaking their language. In real time. In your own voice.**

VoiceBridge captures your microphone, transcribes your speech, translates it through an LLM, clones your voice, and injects the translated audio directly into the meeting — all in under two seconds. Other participants don't install anything. They don't configure anything. They just hear you, speaking their language, as if you always could.

This is not incremental improvement. This is a category of one.

---

## The Pipeline

```
  ┌─────────┐    ┌───────────┐    ┌─────────────┐    ┌───────────┐    ┌──────────┐
  │  Your    │───▶│ Transcribe│───▶│  Translate   │───▶│ Your Clone│───▶│  Their   │
  │  Voice   │    │  (Scribe) │    │   (LLM)      │    │  Voice    │    │  Ears    │
  │  16kHz   │    │  500ms    │    │   300ms      │    │  300ms    │    │  48kHz   │
  └─────────┘    └───────────┘    └─────────────┘    └───────────┘    └──────────┘
```

Five stages. Under two seconds. Zero compromise.

| Stage | What Happens | Technology | Latency Budget |
|-------|-------------|-----------|----------------|
| Capture | Your mic audio is captured on a dedicated audio thread | Web Audio API + AudioWorklet | 250ms |
| Transcribe | Speech becomes text in real-time via WebSocket | ElevenLabs Scribe STT | 500ms |
| Translate | Text is translated token-by-token as it streams | OpenAI / Anthropic / OpenRouter | 300ms |
| Synthesize | Translated text becomes speech in your cloned voice | ElevenLabs Streaming TTS | 300ms |
| Deliver | Translated audio replaces your mic in the meeting | WebRTC track injection | 100ms |

The pipeline doesn't wait for complete sentences. It streams. Token by token. The moment you finish a thought, the translation is already playing.

---

## Features That Change Everything

### Real-Time Voice Translation
Speak naturally. Don't slow down. Don't pause for the machine. VoiceBridge transcribes, translates, and re-speaks in your cloned voice — all while you're still finishing your sentence. The pipeline streams token-by-token. No buffering. No waiting.

### Your Voice. Every Language.
Record 30 seconds. That's all VoiceBridge needs to clone your voice. Now you speak 90+ languages and it still sounds like you. Your colleagues in Tokyo won't know the difference. Your clients in Berlin won't suspect a thing. It's you. In every language.

### Works Where You Work
Google Meet. Zoom. Microsoft Teams. Discord. Any WebRTC app. VoiceBridge injects directly into the meeting's audio stream at the WebRTC layer. No extra software. No virtual audio devices. No "share your screen and play this other app." It just works.

### Ghost Mode 👻
Whisper. Mouth words. Barely make a sound. VoiceBridge amplifies your whisper, transcribes it, translates it, and speaks at full volume in the meeting. You're silent. Your voice isn't. The person next to you on the train has no idea you're in a board meeting in three languages.

### Language Roulette 🎰
One sentence. Ten languages. Your voice. In under 45 seconds. The demo feature that stops rooms cold.

English → Japanese → Spanish → Arabic → French → Mandarin → German → Korean → Portuguese → Hindi.

Back-to-back. No gaps. Your cloned voice in every one. This is the moment judges remember.

### Zero Double-Voice Guarantee
When translation is active, other participants hear ONLY your translated voice. Never your original language. Never both at once. The audio routing state machine ensures seamless switching between your mic and the TTS output with 50ms transitions.

### Graceful Degradation
If TTS goes down, you get text translation. If the LLM goes down, you get transcription. If everything goes down, your original mic stays live. VoiceBridge never blocks you from speaking. Ever.

### Nothing Design Language
Every pixel earns its place. OLED blacks. Space Mono labels. Mechanical toggles. Segmented progress bars. A floating widget that fades to 30% opacity when you're not looking at it. One red accent dot — the only color — pulsing when you're live. The UI of a precision instrument, not a toy.

---

## Try It — Free

VoiceBridge ships with a built-in demo. **5 minutes of voice time, every 24 hours.** Only your speaking time counts — silence, pauses, and listening are free.

No account. No signup. No credit card. Install and go.

Want unlimited? Paste your own API key. Hackathon attendees get the [ElevenLabs Creator plan free](https://hacks.elevenlabs.io/hackathons/4).

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge
npm install
```

### 2. Set up your API keys

```bash
cp .env.example .env
```

Edit `.env`:

```env
# ElevenLabs — get your key at https://elevenlabs.io/app/settings/api-keys
VITE_DEMO_ELEVENLABS_KEY=xi-your-key-here

# LLM for translation — pick one provider
VITE_DEMO_LLM_PROVIDER=openrouter
VITE_DEMO_LLM_KEY=sk-or-your-key-here
VITE_DEMO_OPENROUTER_MODEL=openai/gpt-4o

# Set true to remove voice-time limit
VITE_DEMO_UNLIMITED=true
```

> Hackathon attendees: claim free ElevenLabs Creator plan at [hacks.elevenlabs.io/hackathons/4](https://hacks.elevenlabs.io/hackathons/4)

### 3. Build

```bash
npm run build
```

### 4. Load in Chrome

1. Go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

### 5. Use it

1. Complete the onboarding (record your voice, pick languages)
2. Join a meeting (Google Meet, Teams, Discord, Zoom)
3. Press `Alt+T` or click the VoiceBridge icon
4. Speak — other participants hear your translated voice

That's it. You're multilingual.

→ [Full setup guide](docs/GETTING-STARTED.md)

---

## The Demo

The demo that wins hackathons:

1. **Open a Google Meet call** with a friend
2. **Toggle VoiceBridge on** (Alt+T)
3. **Speak English** — your friend hears Japanese (or Spanish, or Arabic, or any of 90+ languages)
4. **Hit Language Roulette** (Alt+R) — one sentence, ten languages, your voice, 45 seconds
5. **Enable Ghost Mode** (Alt+G) — whisper, and your friend hears full-volume translated speech

Record it. Post it. Tag `@elevenlabsio` and `@kirodotdev`. Use `#ElevenHacks` and `#CodeWithKiro`.

---

## Supported Platforms

| Platform | Injection Strategy | Status |
|----------|-------------------|--------|
| Google Meet | `getUserMedia` intercept | ✓ Full support |
| Microsoft Teams | `RTCPeerConnection.replaceTrack` | ✓ Full support |
| Discord | `RTCPeerConnection.replaceTrack` | ✓ Full support |
| Zoom Web | `tabCapture` fallback | ✓ Full support |
| Any WebRTC app | Generic `replaceTrack` | ✓ Force Enable |

---

## 90+ Languages

**Input**: Every language ElevenLabs Scribe supports. Auto-detect is default.

**Output**: Every language ElevenLabs Multilingual v2 supports. Any-to-any. No restrictions.

The extension fetches supported languages dynamically from the API. When ElevenLabs adds a language, VoiceBridge supports it automatically.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/GETTING-STARTED.md) | Installation, setup, first translation |
| [Architecture](docs/ARCHITECTURE.md) | System design, data flow, state machines, component interfaces |
| [API Reference](docs/API-REFERENCE.md) | Every module, every interface, every type |
| [Platform Adapters](docs/PLATFORM-ADAPTERS.md) | How audio injection works on each meeting platform |

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (strict mode) | Type safety across 5 Chrome execution contexts |
| UI | Vanilla DOM + CSS Custom Properties | Zero framework tax. Bundle size matters for Chrome Web Store. |
| Build | Vite + esbuild | Sub-200ms builds. Tree-shakes aggressively. |
| STT | ElevenLabs Scribe | Real-time WebSocket streaming, 90+ languages |
| TTS | ElevenLabs Multilingual v2 | Voice cloning + streaming synthesis |
| Translation | OpenAI / Anthropic / OpenRouter | Streaming, contextual, 200+ models via OpenRouter |
| Audio | Web Audio API + AudioWorklet | Dedicated audio thread. Zero main-thread blocking. |
| Testing | Vitest + fast-check | Property-based correctness proofs |
| Icons | Lucide (thin) | Monoline. 1.5px stroke. Nothing-compatible. |

No React. No Vue. No Svelte. No Tailwind. No Lodash. No state management library. Just TypeScript and the platform.

---

## Privacy

VoiceBridge is private by design:

- Audio is streamed, never stored — not on disk, not in memory after session ends
- Transcripts exist only in RAM, cleared the moment you stop
- API keys encrypted with AES-GCM-256 via Web Crypto API
- No analytics. No tracking. No telemetry. No third-party scripts.
- Content scripts never touch your API keys — they stay in the offscreen document
- Panic button (Ctrl+Shift+X) kills everything instantly — all connections, all audio, all state

→ [Full privacy details](docs/ARCHITECTURE.md#security-model)

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+T` | Toggle translation on/off |
| `Ctrl+Space` | Push-to-translate (hold to speak) |
| `Ctrl+Shift+X` | Panic stop — kill everything instantly |
| `Alt+G` | Toggle Ghost Mode |

---

## Development

```bash
npm install          # Install dependencies
npm run build        # Production build → dist/
npm run dev          # Watch mode
npm run test         # Run tests
npm run typecheck    # TypeScript strict check
```

Load `dist/` as an unpacked extension in `chrome://extensions/` (Developer mode).

→ [Full development guide](docs/GETTING-STARTED.md#development)

---

## License

MIT — use it, fork it, ship it.

---

<p align="center">
  <br>
  <em>"The people who are crazy enough to think they can change the world are the ones who do."</em>
  <br><br>
  Built for <a href="https://hacks.elevenlabs.io/hackathons/4">ElevenLabs × Kiro Hackathon</a>
  <br>
  <a href="https://elevenlabs.io">ElevenLabs</a> · <a href="https://kiro.dev">Kiro</a>
</p>
