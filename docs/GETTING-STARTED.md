# Getting Started with VoiceBridge

## Prerequisites

- Node.js 18+ and npm
- An ElevenLabs account ([elevenlabs.io](https://elevenlabs.io))
- An LLM API key (OpenAI, Anthropic, or OpenRouter)

## Installation

### From Source

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge/desktop
npm install
```

### Build

```bash
npm run build
```

### Run

```bash
npm start
```

## First Run — Onboarding

On first launch, VoiceBridge asks for your API keys:

1. **ElevenLabs API key** — used for STT (Scribe) and TTS (voice cloning)
2. **LLM provider** — choose OpenRouter, OpenAI, or Anthropic
3. **LLM API key** — key for the chosen provider

Keys are encrypted with AES-GCM-256 and stored locally on your machine. They are never sent anywhere except the API providers you selected. You can change them anytime in Settings.

## Getting API Keys

### ElevenLabs

Hackathon attendees can claim 1 month of the Creator plan (100,000 credits) free:

1. Go to [hacks.elevenlabs.io/hackathons/4](https://hacks.elevenlabs.io/hackathons/4)
2. Sign in
3. Scroll to "Attendee offers"
4. Claim the ElevenLabs Creator plan

Or sign up at [elevenlabs.io](https://elevenlabs.io) — the free tier gives 10,000 credits/month.

### LLM (Translation)

- **OpenRouter**: Sign up at [openrouter.ai](https://openrouter.ai) — some models have free tiers (e.g. `google/gemini-2.5-flash`)
- **OpenAI**: [platform.openai.com](https://platform.openai.com)
- **Anthropic**: [console.anthropic.com](https://console.anthropic.com)

## Usage

### Basic Translation

1. Launch VoiceBridge (it runs in the system tray)
2. Click the tray icon to open the main window
3. Toggle translation on
4. Open any meeting app → select "VoiceBridge Mic" as your microphone
5. Speak — other participants hear your translated voice

### Ghost Mode

Press `Ctrl/Cmd+Shift+G` to enable. Whisper or mouth words — VoiceBridge amplifies, translates, and speaks at full volume.

### Panic Stop

Press `Ctrl/Cmd+Shift+X` to immediately stop all audio capture, close all connections, and write silence to the virtual mic.

## Development

### Build and Run

```bash
cd desktop
npm install
npm run build
npm start
```

### Tests

```bash
npm run test
```

Runs 42 property-based tests via Vitest + fast-check.

### Type Check

```bash
npm run typecheck
```

### Project Structure

```
desktop/
├── src/
│   ├── main/           # Electron main process
│   ├── native/         # N-API addon interface (mock for dev)
│   ├── preload/        # contextBridge API
│   ├── renderer/       # Preact UI (Nothing design system)
│   └── shared/         # Types, platform utilities
├── tests/
│   └── properties/     # Property-based tests (fast-check)
└── package.json
```

The desktop app reuses pure-logic modules from `src/lib/` (STT client, TTS client, translation engine, echo cancellation, audio routing, degradation manager, etc.) — only the I/O layer is replaced with Electron IPC and native audio.
