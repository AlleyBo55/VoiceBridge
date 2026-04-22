# Getting Started with VoiceBridge

## Prerequisites

- Node.js 18+ and npm
- ffmpeg (required for real-time audio capture and output)
- macOS 12+, Ubuntu 22.04+, or Windows 10+
- An ElevenLabs account ([elevenlabs.io](https://elevenlabs.io))
- An LLM API key (OpenAI, Anthropic, or OpenRouter)
- macOS only: [Homebrew](https://brew.sh) (for virtual mic driver)

### Install ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Fedora
sudo dnf install ffmpeg

# Windows — download from https://ffmpeg.org/download.html
# Extract, add the bin/ folder to your PATH
```

ffmpeg handles real-time mic capture and audio output to the virtual microphone. Without it, VoiceBridge cannot capture or output audio.

## Installation

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge/desktop
npm install
```

## Run (Development)

```bash
npm run dev
```

This compiles the main process, starts a Vite dev server for the UI, and launches Electron with DevTools.

## Run (Production)

```bash
npm run build
npm start
```

## First Launch — Onboarding

VoiceBridge walks you through setup on first launch:

### Step 1: API Keys

Enter your API keys. Both are validated against the real APIs before saving.

- **ElevenLabs API key** — for speech-to-text (Scribe v2) and text-to-speech (voice cloning)
- **LLM provider** — OpenRouter, OpenAI, or Anthropic
- **LLM API key** — key for the chosen provider
- **Model** — pick your LLM model (e.g. `openai/gpt-4o` for OpenRouter)

Keys are encrypted (AES-GCM-256) and stored only on your device. VoiceBridge has no server — we never see, collect, or store your keys.

### Step 2: Voice Clone (Optional)

Record 30+ seconds of your voice reading the on-screen prompt. VoiceBridge uploads it to ElevenLabs and creates a voice clone so translations sound like you.

- Requires ElevenLabs Creator plan or higher
- Free tier users can skip this and use a default voice
- You can add multiple voice clones later in Settings

### Step 3: Install Virtual Mic Driver

Click "Install Driver" in the main window:

- **macOS**: Opens Terminal to run `brew install --cask blackhole-2ch`. Enter your password when prompted. Requires a computer restart after install.
- **Linux**: Creates a PulseAudio/PipeWire virtual sink instantly. No restart needed.
- **Windows**: Shows instructions to download and install VB-CABLE manually.

Progress bar shows installation status. If it fails, the app shows the exact error and resolution steps.

## Getting API Keys

### ElevenLabs

Hackathon attendees can claim 1 month of the Creator plan (100,000 credits) free:

1. Go to [hacks.elevenlabs.io/hackathons/4](https://hacks.elevenlabs.io/hackathons/4)
2. Sign in and scroll to "Attendee offers"
3. Claim the ElevenLabs Creator plan

Or sign up at [elevenlabs.io](https://elevenlabs.io) — the free tier gives 10,000 credits/month.

### LLM (Translation)

- **OpenRouter**: [openrouter.ai](https://openrouter.ai) — some models have free tiers (e.g. `google/gemini-2.5-flash`)
- **OpenAI**: [platform.openai.com](https://platform.openai.com)
- **Anthropic**: [console.anthropic.com](https://console.anthropic.com)

## Usage

### Basic Translation

1. Launch VoiceBridge (runs in the system tray)
2. Select your source language ("I Speak") and target language ("Translate To")
3. Toggle translation on
4. Open any meeting app → select "BlackHole 2ch" (macOS) or "VoiceBridge Mic" (Linux) as your microphone
5. Speak — other participants hear your translated voice

### Settings

Click "Settings" at the bottom of the main window to:

- Change API keys (with validation)
- Switch LLM provider and model
- Change source/target languages
- Manage voice clones (add new, select active, delete)
- Install/check virtual mic driver

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+Shift+T` | Toggle translation |
| `Ctrl/Cmd+Shift+G` | Toggle Ghost Mode |
| `Ctrl/Cmd+Shift+X` | Panic stop — kill everything |

### Ghost Mode

Press `Ctrl/Cmd+Shift+G`. Whisper or mouth words — VoiceBridge amplifies, translates, and speaks at full volume.

### Panic Stop

Press `Ctrl/Cmd+Shift+X` to immediately stop all audio capture, close all WebSocket connections, and write silence to the virtual mic.

## How the Pipeline Works

```
Your Mic → [WebSocket] ElevenLabs Scribe v2 STT (150ms)
                ↓ transcript
         [HTTP SSE] LLM Translation (300ms)
                ↓ tokens streamed one-by-one to TTS
         [WebSocket] ElevenLabs Flash v2.5 TTS (75ms)
                ↓ PCM audio
         Resample 24kHz→48kHz → BlackHole virtual mic → Meeting app
```

Total end-to-end: under 1.5 seconds. All connections run in the Electron main process.

## Development

```bash
cd desktop
npm run dev          # Build + launch with hot-reload
npm run test         # 42 property-based tests (Vitest + fast-check)
npm run typecheck    # TypeScript strict mode
```

### Project Structure

```
desktop/
├── src/
│   ├── main/           # Electron main process (pipeline, audio, settings, IPC)
│   ├── native/         # N-API addon interface (mock for dev)
│   ├── preload/        # contextBridge API (security boundary)
│   ├── renderer/       # Preact UI (Nothing design system)
│   └── shared/         # Types, platform utilities
├── scripts/
│   └── dev.mjs         # Dev script (esbuild + Vite + Electron)
├── tests/
│   └── properties/     # Property-based tests (fast-check)
└── package.json
```
