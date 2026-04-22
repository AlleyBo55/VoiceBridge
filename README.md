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

## Why a Desktop App (Not a Chrome Extension)

VoiceBridge started as a Chrome Extension (Phase 1 & 2). We built the full pipeline — STT, translation, TTS, echo cancellation, platform adapters for Meet/Teams/Discord/Zoom. It worked architecturally. But Chrome extensions have a fundamental limitation:

**They can't create a virtual microphone.**

Chrome extensions can only intercept WebRTC connections inside the browser via `replaceTrack()`. This means:
- Each meeting platform needs a custom adapter that breaks when the platform updates
- Content scripts can't reliably inject into all URLs (Teams uses `teams.cloud.microsoft`, not `teams.microsoft.com`)
- The audio bridge between the offscreen document and content script is fragile
- It only works in Chrome, only in the browser, only on supported platforms

The desktop app solves all of this by operating at the OS audio layer:

```
Chrome Extension (old):
  Content Script → getUserMedia intercept → WebRTC replaceTrack → One Meeting App

Desktop App (new):
  Native Addon → Real Mic → Pipeline → Virtual Mic Driver → ANY App
```

Install VoiceBridge. Select "VoiceBridge Mic" as your microphone in Teams, Zoom, Meet, Discord, Slack, FaceTime, WhatsApp — anything. Done.

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
┌─────────────────────────────────────────────────────────────────┐
│                    Electron Desktop App                          │
│                                                                  │
│  ┌──────────────────────┐    ┌──────────────────────────────┐   │
│  │   Main Process        │    │   Renderer Process (Preact)   │   │
│  │   (Node.js + N-API)   │    │   (Nothing Design System)     │   │
│  │                        │    │                                │   │
│  │  Pipeline Orchestrator │◄──►│  Main Window (360×480)        │   │
│  │  Audio Router          │ IPC│  System Tray                   │   │
│  │  Native Audio Addon    │    │  Settings View                 │   │
│  │  Settings Store        │    │  Debug Log View                │   │
│  │  Driver Installer      │    │                                │   │
│  └──────────┬─────────────┘    └──────────────────────────────┘   │
│             │                                                      │
│             ▼                                                      │
│  ┌──────────────────────┐                                          │
│  │   Native Audio Addon  │                                          │
│  │   (napi-rs / Rust)    │                                          │
│  │                        │                                          │
│  │  Real Mic Capture      │                                          │
│  │  Virtual Mic Write     │                                          │
│  │  Device Enumeration    │                                          │
│  │  Resampling            │                                          │
│  └──────────┬─────────────┘                                          │
└─────────────┼────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    OS Audio Layer                                 │
│                                                                  │
│  ┌──────────────┐    ┌──────────────────────┐                    │
│  │ Real Mic      │    │ Virtual Mic Driver    │                    │
│  │ (hardware)    │    │ "VoiceBridge Mic"     │                    │
│  └──────────────┘    └──────────┬───────────┘                    │
│                                  │                                │
│                                  ▼                                │
│                    ┌──────────────────────┐                       │
│                    │ Any Meeting App       │                       │
│                    │ Teams / Zoom / Meet   │                       │
│                    │ Discord / Slack / etc  │                       │
│                    └──────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

### Virtual Mic Driver (Per OS)

| OS | Driver Technology | Install Method |
|----|------------------|----------------|
| macOS | CoreAudio HAL Plugin | `sudo` (copies to `/Library/Audio/Plug-Ins/HAL/`) |
| Windows | WASAPI Virtual Audio Endpoint | Administrator elevation |
| Linux | PulseAudio null sink + module-loopback | User-space (no elevation) |

### Module Reuse from Chrome Extension

| Module | Status | Notes |
|--------|--------|-------|
| PipelineOrchestrator | Reuse | Replace chrome.* with Electron IPC |
| STTClient | Reuse | Pure WebSocket — no changes |
| TranslationEngine | Reuse | Pure HTTP streaming — no changes |
| TTSClient | Reuse | Pure WebSocket — no changes |
| EchoCancellationModule | Reuse | Pure state machine — no changes |
| LatencyMonitor | Reuse | Pure timing logic — no changes |
| DegradationManager | Reuse | Pure state computation — no changes |
| CleanupSequencer | Reuse | Pure cleanup orchestration — no changes |
| AudioCaptureModule | Replace | N-API native capture instead of getUserMedia |
| AudioOutputModule | Replace | N-API virtual mic write instead of WebRTC |
| SettingsStore | Replace | Filesystem JSON + Node.js crypto instead of chrome.storage |
| MessageBus | Replace | Electron IPC instead of chrome.runtime.sendMessage |
| MeetingDetector | Remove | Not needed — virtual mic works with any app |
| PlatformAdapters | Remove | Not needed — no per-app injection |
| AudioBridge | Remove | Not needed — direct N-API calls |

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
cd VoiceBridge
npm install
```

### 2. Set up your API keys

```bash
cp .env.example .env
```

Edit `.env`:

```env
VITE_DEMO_ELEVENLABS_KEY=xi-your-key-here
VITE_DEMO_LLM_PROVIDER=openrouter
VITE_DEMO_LLM_KEY=sk-or-your-key-here
VITE_DEMO_OPENROUTER_MODEL=openai/gpt-4o
VITE_DEMO_UNLIMITED=true
```

### 3. Build and run

```bash
npm run build
npm start
```

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
npm install          # Install dependencies
npm run build        # Build desktop app
npm start            # Launch app
npm run test         # Run tests
npm run typecheck    # TypeScript strict check
```

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

<p align="center">
  <br>
  <em>"The people who are crazy enough to think they can change the world are the ones who do."</em>
  <br><br>
  Built for <a href="https://hacks.elevenlabs.io/hackathons/4">ElevenLabs × Kiro Hackathon</a>
  <br>
  <a href="https://elevenlabs.io">ElevenLabs</a> · <a href="https://kiro.dev">Kiro</a>
</p>
