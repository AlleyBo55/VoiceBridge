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
| Capture | Real mic audio captured via native addon | N-API (napi-rs) + OS audio API | 10ms |
| Transcribe | Speech becomes text in real-time | ElevenLabs Scribe v2 Realtime | 150ms |
| Translate | Text translated token-by-token | OpenAI / Anthropic / OpenRouter | 300ms |
| Synthesize | Translated text becomes speech in your voice | ElevenLabs Flash v2.5 TTS | 75ms |
| Output | Translated audio written to virtual mic | Native audio driver | 10ms |

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
│  │  Native Addon     │                                 │
│  │  (napi-rs / Rust) │                                 │
│  │                    │                                 │
│  │  • Mic Capture     │                                 │
│  │  • Virtual Mic     │                                 │
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

| OS | Driver Technology | Install Method |
|----|------------------|----------------|
| macOS | CoreAudio HAL Plugin | `sudo` (copies to `/Library/Audio/Plug-Ins/HAL/`) |
| Windows | WASAPI Virtual Audio Endpoint | Administrator elevation |
| Linux | PulseAudio null sink + module-loopback | User-space (no elevation) |

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

### 1. Clone and install

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge/desktop
npm install
```

### 2. Build and run

```bash
npm run build
npm start
```

### 3. Enter your API keys

On first launch, VoiceBridge asks for your API keys:

- **ElevenLabs API key** — for speech-to-text (Scribe) and text-to-speech (voice cloning)
- **LLM API key** — for translation (OpenAI, Anthropic, or OpenRouter)

Keys are encrypted with AES-GCM-256 and stored locally. Never sent anywhere except the API providers. You can change them anytime in Settings.

### 4. Use it

1. VoiceBridge installs the virtual mic driver (one-time, requires admin)
2. Open any meeting app → select "VoiceBridge Mic" as your microphone
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
| Native Audio | napi-rs (Rust) | Safe, fast, cross-compiles per OS |
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
npm run build        # Build desktop app
npm start            # Launch app
npm run test         # Run tests (42 property-based tests)
npm run typecheck    # TypeScript strict check
```

### Project Structure

```
desktop/
├── src/
│   ├── main/           # Electron main process
│   │   ├── main.ts             # Entry point, tray, window, IPC handlers
│   │   ├── audio-router.ts     # Mic capture, VAD, noise gate, virtual mic output
│   │   ├── desktop-pipeline.ts # Pipeline adapter (wraps existing orchestrator)
│   │   ├── desktop-settings-store.ts  # AES-GCM-256 encrypted JSON settings
│   │   ├── desktop-latency.ts  # Latency monitor with color mapping
│   │   ├── desktop-debug-log.ts # 500-entry ring buffer
│   │   ├── driver-installer.ts # Virtual mic driver install/uninstall
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

### Reused Modules (from `src/lib/`)

The desktop app reuses these pure-logic modules unchanged:

| Module | Purpose |
|--------|---------|
| `stt-client.ts` | ElevenLabs Scribe v2 WebSocket client |
| `tts-client.ts` | ElevenLabs Flash v2.5 WebSocket client |
| `translation-engine.ts` | LLM streaming translation (OpenAI/Anthropic/OpenRouter) |
| `echo-cancellation.ts` | Three-state echo cancellation machine |
| `audio-routing.ts` | Pure audio routing state machine |
| `degradation-manager.ts` | Graceful degradation cascade |
| `cleanup-sequencer.ts` | Deterministic ordered cleanup |
| `latency-monitor.ts` | Per-stage timing |
| `debug-log.ts` | Circular log buffer |
| `languages.ts` | Language list |
| `types.ts` | All shared type definitions |

---

## Project History

| Phase | What | Status |
|-------|------|--------|
| Phase 1 | Chrome Extension — core pipeline, UI, onboarding | ✓ Complete |
| Phase 2 | Pipeline hardening — orchestrator, state machines, degradation | ✓ Complete |
| Phase 3 | Desktop app rewrite — virtual mic driver, Electron, native audio | 🔄 In Progress |

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
