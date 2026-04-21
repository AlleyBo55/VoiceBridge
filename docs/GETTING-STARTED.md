# Getting Started with VoiceBridge

## Prerequisites

- Chrome 120+ (Manifest V3 support)
- Node.js 18+ and npm
- An ElevenLabs account ([elevenlabs.io](https://elevenlabs.io))
- An LLM API key (OpenAI, Anthropic, or OpenRouter)

## Installation

### From Source

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge
npm install
```

### Configure API Keys

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```env
VITE_DEMO_KEY_ENABLED=true
VITE_DEMO_ELEVENLABS_KEY=xi-your-key-here
VITE_DEMO_LLM_PROVIDER=openrouter
VITE_DEMO_LLM_KEY=sk-or-your-key-here
VITE_DEMO_OPENROUTER_MODEL=openai/gpt-4o
VITE_DEMO_UNLIMITED=true
```

| Variable | Description |
|----------|-------------|
| `VITE_DEMO_ELEVENLABS_KEY` | ElevenLabs API key for STT + TTS |
| `VITE_DEMO_LLM_PROVIDER` | `openai`, `anthropic`, or `openrouter` |
| `VITE_DEMO_LLM_KEY` | API key for the chosen LLM provider |
| `VITE_DEMO_OPENROUTER_MODEL` | Model slug when using OpenRouter (e.g. `openai/gpt-4o`) |
| `VITE_DEMO_UNLIMITED` | Set `true` to disable voice-time limit |
| `VITE_DEMO_VOICE_LIMIT_SECONDS` | Voice-time limit in seconds (default: 300) |

### Build

```bash
npm run build
```

This produces a `dist/` folder containing the complete Chrome extension.

### Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder

The VoiceBridge icon appears in your toolbar.

## First Run — Onboarding

On first install, VoiceBridge opens the onboarding wizard:

1. **Welcome** — overview and demo limits
2. **API Keys** — skipped automatically if `.env` keys are embedded in the build
3. **Voice Recording** — record 30 seconds of your voice for cloning
4. **Language Selection** — pick your source and target languages
5. **Test** — run a full pipeline test to verify everything works

## Getting Free API Credits

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

1. Join a meeting (Google Meet, Teams, Discord, Zoom)
2. Click the VoiceBridge icon or press `Alt+T`
3. Speak — other participants hear your translated voice

### Ghost Mode

Press `Alt+G` to enable. Whisper or mouth words — VoiceBridge amplifies, translates, and speaks at full volume.

### Language Roulette

Press the Roulette button in the popup. Speak one sentence — hear it in 10 languages back-to-back in your cloned voice.

### Push-to-Translate

Hold `Ctrl+Space` — translation only happens while you hold the key. Release to stop.

### Panic Stop

Press `Ctrl+Shift+X` to immediately stop all audio capture, close all connections, and restore your original microphone.

## Development

### Watch Mode

```bash
npm run dev
```

Rebuilds on file changes. Reload the extension in Chrome after each build.

### Type Check

```bash
npm run typecheck
```

Runs `tsc --noEmit` with strict mode.

### Tests

```bash
npm run test
```

Runs Vitest with property-based tests via fast-check.

### Project Structure

```
src/
├── background/          # Service worker (orchestrator)
├── offscreen/           # Offscreen document (pipeline host)
├── content/             # Content script (widget + audio injection)
├── popup/               # Extension popup UI
├── sidepanel/           # Side panel (live transcript)
├── options/             # Settings page
├── onboarding/          # First-time setup wizard
├── lib/                 # Core modules (STT, TTS, translation, audio, etc.)
├── worklets/            # AudioWorklet processor
├── styles/              # Nothing Design System CSS
├── icons/               # Extension icons (SVG + PNG)
└── manifest.json        # Manifest V3 configuration
```
