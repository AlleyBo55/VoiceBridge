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
| LLM API key | [openrouter.ai](https://openrouter.ai) / [openai.com](https://platform.openai.com) / [anthropic.com](https://console.anthropic.com) | same | same |

ffmpeg is required for real-time mic capture and virtual mic audio output. Without it, VoiceBridge falls back to a silent mock (no audio).

---

## The Pipeline

```
  ┌─────────┐    ┌───────────┐    ┌─────────────┐    ┌───────────┐    ┌──────────────┐
  │  Your    │───▶│ Transcribe│───▶│  Translate   │───▶│ Your Clone│───▶│  Virtual Mic │
  │  Voice   │    │  (Scribe) │    │   (LLM)      │    │  Voice    │    │  "VoiceBridge│
  │  16kHz   │    │  150ms    │    │   300ms      │    │  75ms     │    │   Mic"       │
  └─────────┘    └───────────┘    └─────────────┘    └───────────┘    └──────────────┘
```

Five stages. Under 1.5 seconds. Works everywhere.

| Stage | What Happens | Technology | Latency |
|-------|-------------|-----------|---------|
| Capture | Real mic audio captured via ffmpeg | avfoundation (macOS) / pulse (Linux) / dshow (Windows) | 10ms |
| Transcribe | Speech becomes text in real-time | ElevenLabs Scribe v2 Realtime | 150ms |
| Translate | Text translated token-by-token | OpenAI / Anthropic / OpenRouter | 300ms |
| Synthesize | Translated text becomes speech in your voice | ElevenLabs Flash v2.5 TTS | 75ms |
| Output | Translated audio written to virtual mic | ffmpeg → BlackHole / PulseAudio / VB-CABLE | 10ms |

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

VoiceBridge needs a virtual audio device so meeting apps can select it as a microphone. The app installs this automatically — click "Install Driver" in the main window.

| OS | What Gets Installed | How |
|----|-------------------|-----|
| macOS | [BlackHole 2ch](https://existential.audio/blackhole/) | `brew install blackhole-2ch` (requires [Homebrew](https://brew.sh)) |
| Ubuntu/Linux | PulseAudio/PipeWire null sink | `pactl load-module module-null-sink` (no elevation needed) |
| Windows | [VB-CABLE](https://vb-audio.com/Cable/) | Manual download + Run as Administrator |

**If install fails**, VoiceBridge shows the exact error and step-by-step resolution:

| Error | Resolution |
|-------|-----------|
| macOS: "Homebrew not found" | Install Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` |
| macOS: "Permission denied" | Run `brew install blackhole-2ch` manually in Terminal |
| macOS: "Xcode CLT required" | Run `xcode-select --install` first |
| Linux: "No PulseAudio" | Install: `sudo apt install pulseaudio` (Ubuntu) or `sudo dnf install pulseaudio` (Fedora) |
| Linux: "Daemon not running" | Start it: `systemctl --user start pipewire pipewire-pulse` |
| Linux: "Module init failed" | Unload first: `pactl unload-module module-null-sink`, then retry |
| Windows | Download VB-CABLE from [vb-audio.com/Cable](https://vb-audio.com/Cable/), run installer as Admin, reboot |

After the driver is installed, select "BlackHole 2ch" (macOS), "VoiceBridge Mic" (Linux), or "CABLE Output" (Windows) as your microphone in any meeting app.

---

## Features

### Real-Time Voice Translation
Speak naturally. Your words are transcribed, translated, and re-spoken in your cloned voice — all while you're still finishing your sentence. Token-by-token streaming. No waiting.

### Your Voice. Every Language.
Record 30 seconds. VoiceBridge clones your voice. Now you speak 90+ languages and it still sounds like you.

### Works With Everything
Teams. Zoom. Google Meet. Discord. Slack. FaceTime. WhatsApp. Any app that uses a microphone. Select "VoiceBridge Mic" and go.

### Ghost Mode 👻
Whisper into the mic. VoiceBridge amplifies, translates, and speaks at full volume. You're silent. Your voice isn't.

### Nothing Design Language
OLED blacks. Space Mono labels. Mechanical toggles. System tray app that stays out of your way.

---

## Quick Start

### 1. Install prerequisites

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows — download from https://ffmpeg.org/download.html and add to PATH
```

### 2. Clone and install

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge/desktop
npm install
```

### 3. Build and run

```bash
npm run dev
```

### 4. Enter your API keys

On first launch, VoiceBridge walks you through onboarding:

1. **API Keys** — enter your ElevenLabs key and LLM key (OpenAI, Anthropic, or OpenRouter). Keys are validated against the APIs before saving. Pick your LLM model (e.g. `openai/gpt-4o` for OpenRouter).
2. **Voice Clone** — record 30+ seconds of your voice reading a prompt. VoiceBridge uploads it to ElevenLabs and creates a voice clone. You can skip this to use a default voice.

Keys are encrypted with AES-GCM-256 and stored only on your device. VoiceBridge has no server — we never see your keys. You can change everything later in Settings.

### 5. Install the virtual mic driver

Click "Install Driver" in the main window. This is a one-time setup:
- **macOS**: Installs BlackHole 2ch via Homebrew (~30 seconds)
- **Linux**: Creates a PulseAudio/PipeWire virtual sink (instant)
- **Windows**: Shows instructions to download VB-CABLE

If it fails, the app shows the exact error and how to fix it.

### 6. Use it

1. Open any meeting app → select "BlackHole 2ch" (macOS) or "VoiceBridge Mic" (Linux) as your microphone
3. Toggle translation on in the VoiceBridge tray app
4. Speak — other participants hear your translated voice

---

## 90+ Languages

**Input**: Every language ElevenLabs Scribe supports. Auto-detect is default.
**Output**: Every language ElevenLabs TTS supports. Any-to-any. No restrictions.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| App Shell | Electron | Cross-platform desktop, native addon support |
| UI | Preact + CSS Custom Properties | 3KB gzipped, Nothing design system |
| Audio I/O | ffmpeg (avfoundation / pulse / dshow) | Real mic capture + virtual mic output, cross-platform |
| Virtual Mic | BlackHole (macOS) / PulseAudio (Linux) / VB-CABLE (Windows) | OS-level virtual audio device |
| STT | ElevenLabs Scribe v2 Realtime | 150ms latency, 90+ languages |
| TTS | ElevenLabs Flash v2.5 | 75ms latency, voice cloning |
| Translation | OpenAI / Anthropic / OpenRouter | Streaming, contextual, 200+ models |
| Testing | Vitest + fast-check | Property-based correctness |

---

## Privacy

- Audio is streamed, never stored — not on disk, not after session ends
- API keys encrypted with AES-GCM-256 via Node.js crypto
- No analytics. No tracking. No telemetry.
- No embedded keys — the build ships completely empty
- API keys never leave the main process — renderer has no access
- Panic button (Ctrl/Cmd+Shift+X) kills everything instantly

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+Shift+T` | Toggle translation |
| `Ctrl/Cmd+Shift+G` | Toggle Ghost Mode |
| `Ctrl/Cmd+Shift+X` | Panic stop — kill everything |

---

## Development

```bash
cd desktop
npm install          # Install dependencies
npm run dev          # Build + launch Electron with hot-reload renderer
npm run test         # Run tests (42 property-based tests)
npm run typecheck    # TypeScript strict check
```

`npm run dev` compiles the main process + preload with esbuild, starts a Vite dev server for the renderer, and launches Electron with DevTools open.

### Project Structure

```
desktop/
├── src/
│   ├── main/           # Electron main process
│   │   ├── main.ts             # Entry point, tray, window, IPC handlers
│   │   ├── audio-router.ts     # Mic capture, VAD, noise gate, virtual mic output
│   │   ├── desktop-pipeline.ts # End-to-end: Mic → STT → LLM → TTS → BlackHole
│   │   ├── desktop-settings-store.ts  # AES-GCM-256 encrypted JSON settings
│   │   ├── desktop-latency.ts  # Latency monitor with color mapping
│   │   ├── desktop-debug-log.ts # 500-entry ring buffer
│   │   ├── driver-installer.ts # Real virtual mic driver (BlackHole/PulseAudio/VB-CABLE)
│   │   ├── desktop-voice-profile.ts # Multi-voice clone management via ElevenLabs API
│   │   ├── auto-start.ts       # Login item management
│   │   ├── language-service.ts  # Language list caching + filtering
│   │   ├── panic-stop.ts       # Global Cmd/Ctrl+Shift+X
│   │   └── electron-ipc.ts     # Typed IPC with validation
│   ├── native/         # N-API addon interface (Rust, mock for dev)
│   ├── preload/        # contextBridge API (security boundary)
│   ├── renderer/       # Preact UI (Nothing design system)
│   └── shared/         # Types, platform utilities
├── tests/
│   └── properties/     # Property-based tests (fast-check)
└── package.json
```

### Pipeline Architecture

The desktop pipeline (`desktop-pipeline.ts`) wires the full translation flow directly:

```
Mic Capture → [WebSocket] ElevenLabs Scribe v2 STT
                    ↓ transcript
            [HTTP SSE] LLM Translation (OpenAI/Anthropic/OpenRouter)
                    ↓ tokens streamed one-by-one
            [WebSocket] ElevenLabs Flash v2.5 TTS
                    ↓ PCM audio
            Resample 24kHz→48kHz → Write to BlackHole
```

All connections run in the Electron main process. No browser APIs, no offscreen documents, no content scripts. The renderer only shows the UI — all audio and API calls happen in Node.js.

### Reference Modules (from `src/lib/`)

The Chrome extension's pure-logic modules are kept as reference:

| Module | Purpose |
|--------|---------|
| `echo-cancellation.ts` | Three-state echo cancellation machine |
| `audio-routing.ts` | Pure audio routing state machine |
| `degradation-manager.ts` | Graceful degradation cascade |
| `cleanup-sequencer.ts` | Deterministic ordered cleanup |
| `latency-monitor.ts` | Per-stage timing |
| `types.ts` | All shared type definitions |

---

## Project History

| Phase | What | Status |
|-------|------|--------|
| Phase 1 | Chrome Extension — core pipeline, UI, onboarding | ✓ Complete |
| Phase 2 | Pipeline hardening — orchestrator, state machines, degradation | ✓ Complete |
| Phase 3 | Desktop app — Electron, virtual mic, end-to-end pipeline | ✓ Complete |

---

## License

MIT — use it, fork it, ship it.

---

## Built With Spec-Driven Development

This entire project was built using [Kiro](https://kiro.dev)'s spec-driven development — you write specifications for what you want to build, and the AI agent helps you implement them systematically. Every feature started as a requirement, became a design, then became code.

### The Specs

**Phase 1 — Chrome Extension (Core Pipeline)**
- [Requirements](.kiro/specs/voice-translate-chrome-extension/requirements.md) — 34 requirements, 200+ acceptance criteria
- [Design](.kiro/specs/voice-translate-chrome-extension/design.md) — system architecture, state machines, WebSocket protocols
- [Tasks](.kiro/specs/voice-translate-chrome-extension/tasks.md) — 30 implementation tasks

**Phase 2 — Pipeline Hardening**
- [Requirements](.kiro/specs/pipeline-hardening/requirements.md) — 10 requirements for production-quality pipeline
- [Design](.kiro/specs/pipeline-hardening/design.md) — 7 new components, 15 correctness properties
- [Tasks](.kiro/specs/pipeline-hardening/tasks.md) — 18 tasks with checkpoints

**Phase 3 — Desktop App Rewrite (Virtual Microphone)**
- [Requirements](.kiro/specs/desktop-app-rewrite/requirements.md) — 12 requirements for cross-platform desktop app
- [Design](.kiro/specs/desktop-app-rewrite/design.md) — Electron + N-API architecture, 21 correctness properties
- [Tasks](.kiro/specs/desktop-app-rewrite/tasks.md) — 19 tasks, 48 sub-tasks

### The Hackathon

Built for [ElevenLabs × Kiro Hackathon (Hack #5)](https://hacks.elevenlabs.io/hackathons/4) — a weekly hackathon challenging developers to build AI-powered apps using Kiro's spec-driven development and ElevenLabs APIs.

---

<p align="center">
  <br>
  <em>"The people who are crazy enough to think they can change the world are the ones who do."</em>
  <br><br>
  Built for <a href="https://hacks.elevenlabs.io/hackathons/4">ElevenLabs × Kiro Hackathon</a>
  <br>
  <a href="https://elevenlabs.io">ElevenLabs</a> · <a href="https://kiro.dev">Kiro</a> · <a href="https://hacks.elevenlabs.io/hackathons/4?sc_channel=sm&sc_publisher=TWITTER&sc_country=global&sc_geo=GLOBAL&sc_outcome=awareness">#ElevenHacks</a> · <a href="https://x.com/kirodotdev">#CodeWithKiro</a>
</p>
