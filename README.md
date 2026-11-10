<p align="center">
  <img src="src/icons/icon.svg" width="80" height="80" alt="VoiceBridge">
</p>

<h1 align="center">VoiceBridge</h1>

<p align="center">
  <strong>Speak any language. In your own voice.</strong>
</p>

<p align="center">
  <em>Real-time voice translation with a virtual microphone — works in every meeting app.</em>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="docs/ARCHITECTURE.md">Architecture</a> · <a href="docs/GETTING-STARTED.md">Setup Guide</a> · <a href="docs/API-REFERENCE.md">API Reference</a>
</p>

---

<p align="center">
  <em>English → Japanese → Indonesian → Russian → Korean , real-time, in the speaker's own cloned voice.</em>
</p>

---

## Screenshots

<p align="center">
  <img src="public/screenshots/1.png" width="360" alt="Onboarding — API Keys" />
  <img src="public/screenshots/2.png" width="360" alt="Onboarding — Voice Clone" />
</p>
<p align="center">
  <img src="public/screenshots/3.png" width="360" alt="Main View — Translation Active" />
  <img src="public/screenshots/4.png" width="360" alt="Settings" />
</p>

---

## Demo

[https://github.com/user-attachments/assets/demo.mov
](https://github.com/user-attachments/assets/a6d14b28-c75f-4267-9a57-6776f1dd8cb2)

---

## One More Thing.

You're in a meeting with colleagues in Tokyo, clients in São Paulo, and partners in Berlin. You speak Indonesian. They hear you — fluently, naturally, instantly — in Japanese, Portuguese, and German. In *your* voice.

Not a robotic translation. Not a subtitle at the bottom of the screen. Not a five-second delay while some server thinks about it.

**You. Speaking their language. In real time. In your own voice.**

VoiceBridge captures your microphone, transcribes your speech, translates it through an LLM, clones your voice, and outputs the translated audio through a virtual microphone — so any meeting app hears the translated version. Other participants don't install anything. They don't configure anything. They just hear you, speaking their language, as if you always could.

---

## Prerequisites

| Requirement | macOS | Ubuntu/Linux | Windows |
|------------|-------|-------------|---------|
| Node.js 18+ | [nodejs.org](https://nodejs.org) | `sudo apt install nodejs npm` | [nodejs.org](https://nodejs.org) |
| ffmpeg | `brew install ffmpeg` | `sudo apt install ffmpeg` | [ffmpeg.org/download](https://ffmpeg.org/download.html) |
| Homebrew | [brew.sh](https://brew.sh) | — | — |
| PulseAudio/PipeWire | — | Pre-installed on Ubuntu 22.04+ | — |
| ElevenLabs API key | [elevenlabs.io](https://elevenlabs.io) | [elevenlabs.io](https://elevenlabs.io) | [elevenlabs.io](https://elevenlabs.io) |
| LLM API key | [openai.com](https://platform.openai.com) / [anthropic.com](https://console.anthropic.com) / [openrouter.ai](https://openrouter.ai) / [huggingface.co](https://huggingface.co/settings/tokens), or none for a local server (Ollama, LM Studio) | same | same |

ffmpeg is required for real-time mic capture. Translated speech streams through sox's `play` (or `ffplay`, which ships with most ffmpeg builds). Without ffmpeg, VoiceBridge falls back to a silent mock (no audio).

---

## The Pipeline

```
  ┌─────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
  │  Your    │───▶│  Transcribe  │───▶│  Translate   │───▶│  Your Clone  │───▶│  Virtual Mic │
  │  Voice   │    │ Scribe v3    │    │  any LLM     │    │  Eleven v4   │    │  "VoiceBridge│
  │  16kHz   │    │ Live         │    │  (streamed)  │    │  Turbo       │    │   Mic"       │
  └─────────┘    └──────────────┘    └─────────────┘    └──────────────┘    └──────────────┘
```

Translation tokens stream straight into the voice, and the voice streams straight to the speaker, so your clone starts talking while the sentence is still being translated.

| Stage | What Happens | Technology |
|-------|-------------|-----------|
| Capture | Real mic audio captured via ffmpeg | avfoundation (macOS) / pulse (Linux) / dshow (Windows) |
| Transcribe | Speech becomes text; turn prediction commits when you finish the thought, not at the first pause | ElevenLabs Scribe v3 Live, background-audio filtering |
| Translate | Text translated token by token, with the last 10 utterances and your glossary as context | OpenAI, Anthropic, OpenRouter, Hugging Face, or any OpenAI-compatible server |
| Synthesize | Translated text becomes speech in your cloned voice | ElevenLabs Eleven v4 Turbo (or Flash v2.5 / Multilingual v2) |
| Output | Translated audio streamed to the output device / virtual mic | sox `play` or ffplay → BlackHole / PulseAudio / VB-CABLE |

**Delay:** not zero. The model latencies are small (ElevenLabs quotes ~100 ms for Eleven v4 Turbo), but the voice needs about 8 words of translation before it starts, and the network adds round trips. Expect roughly a second after you stop talking; the app shows the measured delay of every utterance.

### Translation engines

The pipeline above is the default **cascade** engine. Settings → Translation engine also offers speech-to-speech models that do all three stages in one hop and translate while you are still talking:

| Engine | Voice the meeting hears | Languages | Audio processed by |
|--------|------------------------|-----------|--------------------|
| Cascade (default) | Your ElevenLabs clone | input 90+, output: 90+ with Eleven v4 Turbo | ElevenLabs + your LLM provider |
| Qwen3.8 LiveTranslate | A clone Qwen makes from your first seconds of speech | understands 60, speaks 29 | Alibaba Cloud (Singapore or Beijing) |
| OpenAI GPT-Realtime-Translate | OpenAI's voice | 70+ in, 13 out | OpenAI |
| Gemini 3.5 Live Translate (preview) | Keeps your intonation and pitch, not a clone | 70+ | Google |

### Translation models

The model picker loads each provider's live model list, so new models show up without an app update:

| Provider | Default | Notes |
|----------|---------|-------|
| OpenAI | `gpt-6-luna` | sent with `reasoning_effort: none` for speed |
| Anthropic | `claude-haiku-5-5` | thinking disabled where the model allows it |
| OpenRouter | `openai/gpt-6-luna` | ~400 models: OpenAI, Anthropic, Google, Qwen, DeepSeek, Meta, Mistral, xAI… |
| Hugging Face | `Qwen/Qwen3.8-27B:fastest` | open-weights models via Inference Providers, listed fastest first-token first |
| Custom | — | any OpenAI-compatible base URL: Ollama, LM Studio, vLLM, Groq, Together, DeepSeek… |

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                 Electron Desktop App                  │
│                                                      │
│  ┌─────────────────┐   ┌─────────────────────────┐  │
│  │  Main Process    │   │  Renderer (Preact)       │  │
│  │  Node.js + N-API │◄─►│  Nothing Design System   │  │
│  │                  │IPC│                           │  │
│  │  • Pipeline      │   │  • Main Window (360×480) │  │
│  │  • Audio Router  │   │  • System Tray           │  │
│  │  • Settings      │   │  • Settings View         │  │
│  │  • Driver Mgmt   │   │  • Debug Log             │  │
│  └────────┬─────────┘   └─────────────────────────┘  │
│           │                                           │
│  ┌────────▼─────────┐                                 │
│  │  Audio I/O        │                                 │
│  │  (ffmpeg)         │                                 │
│  │                    │                                 │
│  │  • Mic Capture     │                                 │
│  │  • Virtual Mic Out │                                 │
│  │  • Resampling      │                                 │
│  └────────┬───────────┘                                 │
└───────────┼─────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────┐
│                    OS Audio Layer                        │
│                                                         │
│  ┌────────────┐   ┌─────────────────────┐               │
│  │ Real Mic    │   │ "VoiceBridge Mic"   │               │
│  │ (hardware)  │   │ (virtual driver)    │               │
│  └────────────┘   └──────────┬──────────┘               │
│                              │                           │
│                   ┌──────────▼──────────┐               │
│                   │  Any Meeting App     │               │
│                   │  Teams / Zoom / Meet │               │
│                   │  Discord / Slack     │               │
│                   └─────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

### Virtual Mic Driver (Per OS)

| OS | What Gets Installed | How |
|----|-------------------|-----|
| macOS | [BlackHole 2ch](https://existential.audio/blackhole/) | `brew install blackhole-2ch` |
| Ubuntu/Linux | PulseAudio/PipeWire null sink | `pactl load-module module-null-sink` |
| Windows | [VB-CABLE](https://vb-audio.com/Cable/) | Manual download + Run as Administrator |

---

## Features

### Real-Time Voice Translation
Speak naturally. Your words are transcribed, translated, and re-spoken in your cloned voice — all while you're still finishing your sentence.

### Push-to-Talk
Hold SPACE or the on-screen button to talk. Each press is an independent utterance — no accumulation, no feedback loops, no background noise pickup.

### Your Voice. Every Language.
Record 30 seconds. VoiceBridge clones your voice. Now you speak 90+ languages and it still sounds like you.

### Works With Everything
Teams. Zoom. Google Meet. Discord. Slack. FaceTime. WhatsApp. Any app that uses a microphone.

### Nothing Design Language
OLED blacks. Space Mono labels. Mechanical toggles. System tray app that stays out of your way.

---

## Quick Start

### 1. Install prerequisites

```bash
# macOS
brew install ffmpeg sox

# Ubuntu/Debian
sudo apt install ffmpeg sox

# Windows — download from https://ffmpeg.org/download.html
```

### 2. Clone and install

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge/desktop
npm install
```

### 3. Run

```bash
npm run dev
```

### 4. First launch

VoiceBridge walks you through setup:

1. **Prerequisites** — checks for ffmpeg, sox, and virtual mic driver. One-click install for each.
2. **API Keys** — enter your ElevenLabs key and LLM key. Keys are validated before saving.
3. **Voice Clone** — record 30+ seconds of your voice. Skip to use a default voice.

Keys are encrypted with AES-GCM-256 and stored only on your device. VoiceBridge has no server.

### 5. Use it

1. Open any meeting app → select "BlackHole 2ch" as your microphone
2. Toggle translation on in VoiceBridge
3. Hold SPACE and speak — other participants hear your translated voice

---

## 90+ Languages

**Input**: Every language ElevenLabs Scribe v3 Live supports (90+). Auto-detect is default.
**Output**: Depends on the voice model: Eleven v4 Turbo speaks 90+, Flash v2.5 32, Multilingual v2 29. The speech-to-speech engines have their own limits (see the engine table).

## What to expect

- **Faithful, not word-for-word.** The translator is told to keep every idea, name and number, never to summarize or answer questions, and it sees your recent sentences and glossary. Names and jargon can still come out wrong, and translation always rephrases.
- **Sounds like you, not identical.** An instant clone from 30 seconds of speech is close; an ElevenLabs Professional Voice Clone is closer. Accent and emotion can shift between languages.
- **Your voice only.** Clone the voice of the person using the app, with their consent.
- **Windows:** translated speech now plays through ffplay (PowerShell as a fallback) to the default output device; route that to CABLE Input to reach meetings. Not yet tested on Windows.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| App Shell | Electron | Cross-platform desktop, native addon support |
| UI | Preact + CSS Custom Properties | 3KB gzipped, Nothing design system |
| Audio I/O | ffmpeg | Real mic capture + virtual mic output |
| Virtual Mic | BlackHole / PulseAudio / VB-CABLE | OS-level virtual audio device |
| STT | ElevenLabs Scribe v3 Live | Turn prediction, background-audio filtering, 90+ languages |
| TTS | ElevenLabs Eleven v4 Turbo | Streams over the Text to Dialogue WebSocket, voice cloning, 90+ languages |
| Translation | OpenAI / Anthropic / OpenRouter / Hugging Face / OpenAI-compatible | Streaming, live model lists |
| Speech-to-speech | Qwen3.8 LiveTranslate / GPT-Realtime-Translate / Gemini 3.5 Live Translate | Optional engines |
| Testing | Vitest + fast-check | Property-based correctness |

---

## Privacy

- Audio is streamed, never stored
- API keys encrypted with AES-GCM-256
- No analytics. No tracking. No telemetry.
- No embedded keys — the build ships empty
- Panic button (Ctrl/Cmd+Shift+X) kills everything instantly

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Space` | Push-to-talk (hold to speak) |
| `Ctrl/Cmd+Shift+T` | Toggle translation |
| `Ctrl/Cmd+Shift+G` | Toggle Ghost Mode |
| `Ctrl/Cmd+Shift+X` | Panic stop |

---

## Development

```bash
cd desktop
npm install          # Install dependencies
npm run dev          # Build + launch Electron with hot-reload
npm run test         # Run 42 property-based tests
```

### Project Structure

```
desktop/
├── src/
│   ├── main/           # Electron main process
│   │   ├── main.ts             # Entry, tray, window, IPC
│   │   ├── desktop-pipeline.ts # Mic → STT → LLM → TTS → BlackHole
│   │   ├── audio-router.ts     # VAD, noise gate, routing
│   │   ├── driver-installer.ts # Virtual mic driver install
│   │   └── ...
│   ├── native/         # ffmpeg audio I/O
│   ├── preload/        # Security boundary
│   ├── renderer/       # Preact UI
│   └── shared/         # Types, platform utils
└── tests/properties/   # Property-based tests
```

---

## Agent Skill (Agensi)

`agensi/voicebridge-setup/` is a free [Agent Skill](https://agentskills.io/specification) that lets Claude Code, Codex, Cursor or Gemini CLI install, configure and troubleshoot VoiceBridge. It runs a read-only doctor script and asks before every install. It cannot translate meetings itself.

```bash
node agensi/package-skill.mjs   # validates the skill, writes agensi/dist/voicebridge-setup.zip
```

Upload the zip at [agensi.io/sell](https://www.agensi.io/sell) with the price set to Free. Listing copy and the review checklist are in `agensi/LISTING.md`.

---

## Built With Spec-Driven Development

This project was built using [Kiro](https://kiro.dev)'s spec-driven development — requirements → design → implementation, systematically.

### The Specs

**Phase 1 — Chrome Extension**
- [Requirements](.kiro/specs/voice-translate-chrome-extension/requirements.md) · [Design](.kiro/specs/voice-translate-chrome-extension/design.md) · [Tasks](.kiro/specs/voice-translate-chrome-extension/tasks.md)

**Phase 2 — Pipeline Hardening**
- [Requirements](.kiro/specs/pipeline-hardening/requirements.md) · [Design](.kiro/specs/pipeline-hardening/design.md) · [Tasks](.kiro/specs/pipeline-hardening/tasks.md)

**Phase 3 — Desktop App**
- [Requirements](.kiro/specs/desktop-app-rewrite/requirements.md) · [Design](.kiro/specs/desktop-app-rewrite/design.md) · [Tasks](.kiro/specs/desktop-app-rewrite/tasks.md)

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
  <a href="https://elevenlabs.io">ElevenLabs</a> · <a href="https://kiro.dev">Kiro</a> · <a href="https://hacks.elevenlabs.io/hackathons/4?sc_channel=sm&sc_publisher=TWITTER&sc_country=global&sc_geo=GLOBAL&sc_outcome=awareness">#ElevenHacks</a> · <a href="https://x.com/kirodotdev">#CodeWithKiro</a>
</p>
