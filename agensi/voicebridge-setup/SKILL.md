---
name: voicebridge-setup
description: Install, set up and troubleshoot VoiceBridge, a free open-source (MIT) desktop app for real-time voice translation in meetings. VoiceBridge transcribes what the user says, translates it and speaks it in their own cloned voice (ElevenLabs) through a virtual microphone, so Zoom, Google Meet, Microsoft Teams, Discord or Slack hear the translation. Use when the user wants to install or set up VoiceBridge, get meeting translation working, create a virtual microphone (BlackHole, a PulseAudio or PipeWire null sink, VB-CABLE), clone their own voice, choose speech, translation and voice models (ElevenLabs, OpenAI, Anthropic, OpenRouter, Hugging Face, Ollama, Qwen LiveTranslate), or troubleshoot no audio in the meeting, echo, a wrong microphone, API key errors, or ffmpeg and sox problems. Runs a read-only doctor script and asks before every install. It does not translate meetings itself.
license: MIT
compatibility: macOS 12+, Linux with PulseAudio or PipeWire (Ubuntu 22.04+), Windows 10+ (Windows playback of translated speech is new in source builds and untested). A source build needs git, Node.js 18+ and internet access. With the user's approval it installs ffmpeg, sox and a virtual audio driver (BlackHole, a PulseAudio/PipeWire null sink, or VB-CABLE).
metadata:
  author: AlleyBo55
  version: "1.0.0"
  homepage: https://github.com/AlleyBo55/VoiceBridge
---

# VoiceBridge setup

VoiceBridge (https://github.com/AlleyBo55/VoiceBridge, MIT) is an Electron desktop app. It captures the user's microphone, transcribes and translates the speech, and speaks the translation in the user's cloned voice through a virtual microphone. The meeting app uses that virtual microphone, so the other participants hear the translation without installing anything.

This skill gets VoiceBridge installed, configured and working on the user's own machine. The agent cannot run live meeting translation; the user does that in the app.

## When to use

- The user wants to install or set up VoiceBridge, or update a source checkout.
- The user wants their own speech translated live in Zoom, Google Meet, Microsoft Teams, Discord, Slack or another meeting app.
- The user needs the virtual microphone: BlackHole (macOS), a PulseAudio/PipeWire null sink (Linux) or VB-CABLE (Windows).
- The user asks which engine, speech, translation or voice model to use.
- Something is broken: no audio in the meeting, echo, wrong microphone, API errors, ffmpeg or sox not found.

Not for translating recorded files or making subtitles. Refuse any request to imitate another person's voice.

## Safety rules

1. **Ask first.** Before any install, any `sudo` or administrator step, any driver install, and the macOS quarantine removal (`xattr`), show the exact command, say what it changes, and wait for a clear yes. A yes covers only the commands you showed.
2. **Keys stay in the app.** Never ask the user to paste an API key or token into the chat, and never put one in a file, an environment variable or a command. The user types keys into VoiceBridge (onboarding or Settings), which encrypts them on the device with AES-256-GCM. If the user pastes a key anyway, do not repeat or store it, and suggest they revoke it and create a new one.
3. **Recordings stay with the app.** Never upload, copy, move, open or play the user's voice recordings. The app records the voice sample and sends it to ElevenLabs itself when the user clicks.
4. **Only the user's own voice, with their consent.** Clone only the voice of the person using the app, after they agree. Never set VoiceBridge up to imitate anyone else (a colleague, a public figure, a relative), whatever reason is given.
5. **Read before you change.** Run the read-only doctor first. Do not edit VoiceBridge's settings files, unload audio modules or uninstall drivers unless the user asks.
6. **Limited network use.** The only network actions are the ones the user approves: `git clone` and release downloads from GitHub, and OS package managers. This skill sends nothing anywhere itself.

## Workflow

### 1. Run the doctor (read-only)

From this skill's folder (the one containing this SKILL.md):

- macOS or Linux: `bash scripts/doctor.sh [--prebuilt] [PATH_TO_CHECKOUT]`
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 [-Prebuilt] [-Path PATH_TO_CHECKOUT]` (the policy flag applies to that one process only)

Each line reads `OK|MISSING|WARN <check> — <detail>`. A `fix:` line under a failed check gives the exact command; the doctor never runs it. Exit code 0 means every required check passed. Add `--prebuilt` (`-Prebuilt`) when the user will use an installer, which makes node, npm and git optional. Add the checkout path once the repo is cloned.

If the script files are not on disk, run the same checks by hand: `node -v` (18+), `command -v npm`, `git --version`, `ffmpeg -version`, `sox --version`, `command -v play`, and the virtual mic (macOS `system_profiler SPAudioDataType | grep -i blackhole`; Linux `pactl list short sinks | grep voicebridge`; Windows `Get-CimInstance Win32_SoundDevice | Where-Object Name -match 'CABLE'`).

### 2. Install what is missing (ask first)

First agree on prebuilt or source (step 3); node, npm and git are only needed for a source build. Show the commands for the missing items only, get a yes, run them, then open a new terminal so PATH picks them up.

macOS (Homebrew, https://brew.sh):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"  # only if brew is missing
brew install ffmpeg sox             # sox includes the play binary
brew install node git               # source build only
brew install --cask blackhole-2ch   # virtual mic; asks for the macOS password
```

Restart the Mac after installing BlackHole, as the VoiceBridge app also instructs.

Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y ffmpeg sox libsox-fmt-all pulseaudio-utils
sudo apt install -y git nodejs npm  # source build only
```

The apt Node.js is 18+ on Ubuntu 24.04+ and Debian 12+. On Ubuntu 22.04 it is too old; install Node 18+ from https://nodejs.org/en/download instead.

- Fedora: `sudo dnf install -y ffmpeg-free sox pulseaudio-utils git nodejs npm`
- Arch: `sudo pacman -S --needed ffmpeg sox libpulse git nodejs npm`

Linux virtual mic (no sudo; lasts until logout; the app's Install Driver button runs the same command):

```bash
pactl load-module module-null-sink sink_name=voicebridge sink_properties=device.description="VoiceBridge\ Mic"
```

Windows (PowerShell; winget comes with App Installer on Windows 10 and 11):

```powershell
winget install -e --id Gyan.FFmpeg
winget install -e --id ChrisBagwell.SoX   # then add its folder, usually C:\Program Files (x86)\sox-14-4-2, to PATH
winget install -e --id OpenJS.NodeJS.LTS  # source build only
winget install -e --id Git.Git            # source build only
```

VB-CABLE has no unattended install. The user downloads it from https://vb-audio.com/Cable/, extracts the ZIP, right-clicks `VBCABLE_Setup_x64.exe`, chooses Run as administrator, clicks Install Driver and restarts Windows. Before they start, tell them Windows playback of translated speech is new and untested: it needs a source build (it plays through `ffplay`, which comes with the Gyan FFmpeg package) because the 1.0.0 installer plays no translated audio on Windows.

### 3. Get the app

Ask which the user prefers.

**Prebuilt.** Releases: https://github.com/AlleyBo55/VoiceBridge/releases. Version 1.0.0 (April 2026) has:

| OS | Asset | Install |
|---|---|---|
| macOS, Apple Silicon only | `VoiceBridge-1.0.0-arm64.dmg` | open it, drag VoiceBridge to Applications |
| Linux x64 (Debian/Ubuntu) | `VoiceBridge-1.0.0-Linux.deb` | `sudo apt install ./VoiceBridge-1.0.0-Linux.deb` |
| Windows x64 | `VoiceBridge-1.0.0-Windows-Setup.exe` | run the installer |

- Check the releases page for a newer version first; asset names change between versions.
- The user can download in the browser, or you can run `curl -LO <asset URL>` with approval. Compare the file with the sha256 digest shown on the release page: `shasum -a 256 FILE` (macOS), `sha256sum FILE` (Linux), `Get-FileHash FILE` (Windows).
- The builds are not code-signed. On macOS the first launch is blocked: with approval run `xattr -cr /Applications/VoiceBridge.app`, then open the app again. On Windows SmartScreen, the user clicks More info, then Run anyway.
- Version 1.0.0 predates most engines and models in [references/MODELS.md](references/MODELS.md). Intel Macs, ARM Linux and anyone who wants the newer engines should build from source.

**From source.** Ask where to clone, then:

```bash
git clone https://github.com/AlleyBo55/VoiceBridge.git
cd VoiceBridge/desktop
npm install    # downloads Electron and the other dependencies
npm run dev    # builds and launches the app with DevTools
```

For a production-style run use `npm run build` and then `npm start`. To update later: `git pull` in the checkout, then `npm install` in `desktop/`.

### 4. First launch (the user does this in the app)

Explain each onboarding screen; the user does the typing and clicking.

1. **Prerequisites.** ffmpeg, sox and the virtual mic should show as present after step 2. On Linux, use the terminal commands from step 2 rather than the in-app Install buttons; those run `sudo` without a terminal and usually fail.
2. **API keys.** The user enters an ElevenLabs API key, picks the translation (LLM) provider and enters that provider's key and model. The app validates each key before saving and encrypts it on the device. Do not ask to see the keys. If the user restricts the ElevenLabs key, it needs speech to text, text to speech, voices (write) and user (read) access.
3. **Voice clone.** The user reads the on-screen text aloud for at least 30 seconds, in a quiet room, with the headset they will use in meetings, and only in their own voice. Voice cloning needs an ElevenLabs plan that includes it (https://elevenlabs.io/pricing). Without one, skip this screen and pick a default voice.
4. **Microphone permission.** macOS asks for microphone access on first use: Allow. A source build asks on behalf of the terminal or Electron.

### 5. Choose the engine and models

The defaults suit most people: the cascade engine (ElevenLabs Scribe v3 Live, then LLM translation, then the user's cloned voice on `eleven_v4_turbo`) with OpenAI `gpt-6-luna` for translation. Read [references/MODELS.md](references/MODELS.md) before recommending anything else. In short:

- Lowest cost: `eleven_flash_v2_5` when both languages are among its 32, plus a low-cost or local translation model.
- Keep transcript text away from cloud LLMs: a local OpenAI-compatible server (Ollama, LM Studio, vLLM). Audio still goes to ElevenLabs.
- Long talks without pauses: a speech-to-speech engine. Qwen3.8 LiveTranslate clones the speaker's voice; OpenAI GPT-Realtime-Translate and Gemini 3.5 Live Translate do not.

Setting names differ between versions; follow what the app shows.

### 6. Route the audio into the meeting app

1. In the meeting app, set the microphone to the virtual device: `BlackHole 2ch` (macOS), `Monitor of VoiceBridge Mic` (Linux; some apps show `VoiceBridge Mic`), `CABLE Output (VB-Audio Virtual Cable)` (Windows). Zoom: Settings, Audio. Google Meet: Settings, Audio. Teams: Settings, Devices. Discord: User Settings, Voice & Video. Slack: Preferences, Audio & video.
2. Set the meeting app's speaker to the user's headphones, never to the virtual device.
3. In VoiceBridge Settings, Microphone Input stays on the real microphone or headset. Never make the virtual device the system default input.
4. Check where the translated voice goes. The user turns translation on, says a sentence, and watches the meeting app's mic test or input meter. If the meter stays flat while the user hears the translation on their own speakers or headphones, the audio is going to the system output instead of the virtual device:
   - macOS: in Audio MIDI Setup, click +, Create Multi-Output Device, tick the headphones and BlackHole 2ch (enable Drift Correction for BlackHole), then choose that device in System Settings, Sound, Output. Keep the meeting app's speaker on the headphones themselves; if it uses the Multi-Output Device, the other participants are sent back into the meeting. Other system sounds also reach the meeting while this is set, so switch the output back after the call.
   - Linux: run `pavucontrol` (`sudo apt install pavucontrol`, ask first), open the Playback tab while VoiceBridge speaks, and set its stream to VoiceBridge Mic. Avoid `pactl set-default-sink voicebridge`, which sends every system sound into the meeting.
   - Windows (source build only, untested): while VoiceBridge speaks, open Settings, System, Sound, Volume mixer, and set the output of `ffplay` (or `powershell`, the fallback player) to `CABLE Input (VB-Audio Virtual Cable)`. Do not make CABLE Input the default output.
5. Use headphones. Without them, enable Push-to-talk mode in Settings and hold Space in the VoiceBridge window while speaking.

### 7. Re-run the doctor

Run the doctor again, with the checkout path for a source build or `--prebuilt` for an installer. Every required check must be OK; explain any WARN line to the user.

### 8. Hand off

Give the user a short summary:

- what was installed, and how to start the app (Applications or the app menu, or `npm run dev` in `<checkout>/desktop`);
- the microphone to pick in meeting apps, and that the meeting speaker stays on headphones;
- the engine and models chosen, and which keys the app needs;
- shortcuts: Ctrl/Cmd+Shift+T toggles translation, Ctrl/Cmd+Shift+X stops everything, Space is push-to-talk while the VoiceBridge window is focused;
- the expectations below, and where to get help: [references/TROUBLESHOOTING.md](references/TROUBLESHOOTING.md) and https://github.com/AlleyBo55/VoiceBridge/issues.

## Honest expectations

Tell the user these before the first real meeting:

- There is a delay. The cascade engine speaks roughly a second after the user stops talking. Simultaneous engines trail the speaker by about 2 seconds.
- The translation is faithful but not word-for-word. Names and jargon can still come out wrong.
- The cloned voice sounds like the user but is not identical.
- Only the user's own voice may be cloned.
- Keys are entered in the app and encrypted on the device with AES-256-GCM. VoiceBridge has no server; audio and text go only to the providers the user configures.
- On Windows, translated playback is new in source builds and untested; the 1.0.0 installer has none.

## References

- [references/MODELS.md](references/MODELS.md): engines, voice models, translation providers, when to pick which, pricing pages.
- [references/TROUBLESHOOTING.md](references/TROUBLESHOOTING.md): no audio, wrong mic, echo, PATH problems, Linux null sinks, Windows, API errors, Qwen errors, local model servers, push-to-talk.
- `scripts/doctor.sh` and `scripts/doctor.ps1`: the read-only prerequisite checks used in steps 1 and 7.
