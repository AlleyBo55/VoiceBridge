# Agensi listing: VoiceBridge Setup

Copy for the listing form at https://www.agensi.io/sell, plus the material reviewers ask about. The skill itself is in `agensi/voicebridge-setup/`; this file is not part of the upload.

## Listing form

| Field | Value |
|---|---|
| Title | VoiceBridge Setup: Meeting Translation in Your Own Voice |
| One-line summary | Your coding agent installs, configures and troubleshoots VoiceBridge, the open-source app that speaks your words in another language, in your cloned voice, inside Zoom, Meet, Teams, Discord or Slack. |
| Price | Free |
| Category | Productivity. If the form offers a closer category, such as Communication or Audio, use that. |
| Tags | real-time voice translation, meeting translation, virtual microphone, voice cloning, cloned voice, ElevenLabs, Zoom, Google Meet, Microsoft Teams, Discord, setup, troubleshooting, BlackHole, VB-CABLE, PipeWire |
| Supported agents | Claude Code, OpenAI Codex, Cursor, Gemini CLI, and other agents that load Agent Skills (SKILL.md) and can run shell commands with the user's approval |
| Supported systems | macOS 12+, Linux with PulseAudio or PipeWire, Windows 10+ (Windows playback of translated speech is new in source builds and untested) |
| License | MIT |
| Source | https://github.com/AlleyBo55/VoiceBridge |

## Long description

VoiceBridge is a free, MIT-licensed desktop app for speaking in meetings in another language, in your own voice. It transcribes your speech with ElevenLabs Scribe, translates it with the LLM you choose, and speaks the translation in your cloned ElevenLabs voice through a virtual microphone. Zoom, Google Meet, Microsoft Teams, Discord and Slack see an ordinary microphone, so the other participants install nothing.

Getting it running takes several system pieces: ffmpeg, sox, Node.js for a source build, a virtual audio driver (BlackHole on macOS, a PulseAudio or PipeWire null sink on Linux, VB-CABLE on Windows), and the right audio routing in the meeting app. This skill has your coding agent do that work with you. It runs a read-only doctor script, shows the exact install command for anything missing and waits for your yes, gets the app from a prebuilt release or from source, walks you through onboarding (API keys typed into the app, a 30-second clone of your own voice), helps you choose an engine and models, and confirms the meeting app hears the translation.

A model guide covers ElevenLabs Scribe v3 Live and the Eleven v4 Turbo, Flash v2.5 and Multilingual v2 voices; translation through OpenAI, Anthropic, OpenRouter, Hugging Face Inference Providers or any OpenAI-compatible server such as Ollama or LM Studio; and the speech-to-speech engines Qwen3.8 LiveTranslate, OpenAI GPT-Realtime-Translate and Gemini 3.5 Live Translate. A troubleshooting guide covers silent meetings, wrong microphones, echo, tools missing when the app starts from the Dock, Linux null sinks, VB-CABLE, API errors 401, 402 and 429, Qwen region and workspace errors, local model servers and push-to-talk.

The skill is plain about the limits. The translation arrives roughly a second after you stop talking, or about 2 seconds behind you with a simultaneous engine. It is faithful but not word-for-word, and names and jargon can still come out wrong. The clone sounds like you but is not identical. On Windows the app does not yet play translated audio into meetings.

## What it does

- Checks the machine with a read-only doctor script (bash for macOS and Linux, PowerShell for Windows) and prints the exact fix command for each missing piece.
- Installs ffmpeg, sox, Node.js, git and the virtual microphone driver, one approved command at a time.
- Gets VoiceBridge from the GitHub release (1.0.0 for Apple Silicon macOS, Debian/Ubuntu x64 and Windows x64) or builds it from source.
- Explains first-launch onboarding: prerequisites, API keys, voice clone, microphone permission.
- Recommends an engine, voice model and translation provider for the user's languages, budget and privacy needs, with links to each provider's pricing page.
- Sets up the meeting app's microphone and speaker and the system output routing, then checks that the meeting hears the translation.
- Diagnoses common failures with a step-by-step troubleshooting guide.

## What it does not do

- It does not translate meetings. The VoiceBridge app does that; the agent only sets it up.
- It does not install, download or run anything as administrator without showing the command and getting a yes.
- It never asks for, reads, stores or sends API keys. The user types them into the app.
- It never records, uploads, copies or opens voice recordings.
- It will not set up a clone of anyone's voice except the user's own, and refuses requests to imitate other people.
- It does not supply ElevenLabs or LLM accounts or credits. The user needs their own keys, and voice cloning needs an ElevenLabs plan that includes it.
- It cannot guarantee translated audio on Windows: playback there is new in source builds and has not been tested yet.
- It does not edit VoiceBridge's settings files or change the app's code.

## Network and privacy disclosure

- **The skill makes no network calls itself.** It consists of Markdown files and two diagnostic scripts. `scripts/doctor.sh` and `scripts/doctor.ps1` read tool versions, PATH and the local audio device list. They make no network calls, install nothing, write no files and never use sudo or administrator rights.
- **Network use by the agent, only with the user's approval:** `git clone` from github.com; release downloads from github.com; OS package managers (Homebrew, apt, dnf, pacman, winget), which contact their own repositories; the Homebrew install script from raw.githubusercontent.com if Homebrew is missing; and `npm install`, which contacts the npm registry and downloads Electron. Troubleshooting may query a local model server on 127.0.0.1, which stays on the machine.
- **Network use by the VoiceBridge app, not the skill:** the app talks only to the providers the user configures. In the default engine, audio goes to ElevenLabs for transcription and voice synthesis, the voice sample goes to ElevenLabs for cloning, and transcript text goes to the chosen LLM provider, or stays on the machine with a local server. The speech-to-speech engines send audio to Alibaba Cloud (Qwen), OpenAI or Google.
- **Keys:** entered by the user in the app's interface and encrypted on the device with AES-256-GCM. VoiceBridge has no server. The project README states there is no analytics, tracking or telemetry.
- **Voice:** the app records the voice sample and sends it to ElevenLabs when the user clicks. The skill only allows cloning the user's own voice, with their consent.

## Demo video script (about 45 seconds)

Record on a fresh macOS user account or a VM so the installs are real. Use your own voice, mask every key field, and do not show other meeting participants without their consent. Do not speed up the translation segment; viewers should see the real delay.

| Time | Picture | Voice-over or caption |
|---|---|---|
| 0:00 to 0:04 | Title card with the VoiceBridge logo | "VoiceBridge Setup: your agent sets up meeting translation in your own voice." |
| 0:04 to 0:12 | Terminal with a coding agent. The user types: "Set up VoiceBridge so I can speak Japanese in Zoom." The agent runs `scripts/doctor.sh`; the output shows `MISSING sox` with its `fix:` line. | "It starts with a read-only check of your machine." |
| 0:12 to 0:18 | The agent asks: "sox is missing. May I run `brew install sox`?" The user answers yes. The doctor runs again and everything is OK. | "Nothing is installed until you say yes." |
| 0:18 to 0:24 | The agent clones the repo and runs `npm run dev` (this part can be sped up). The VoiceBridge window opens on onboarding. | "It gets the app from a release or builds it from source." |
| 0:24 to 0:31 | The user types keys into the app; the fields show only dots. The user records the voice sample. | "Keys go into the app, never into the chat. Only your own voice is cloned." |
| 0:31 to 0:40 | Zoom audio settings with the microphone set to BlackHole 2ch. VoiceBridge set to English to Japanese, toggle on. The user speaks one English sentence; the Zoom input meter moves and the Japanese plays in the user's voice, about a second later. | "The meeting hears you in Japanese, in your voice, about a second after you finish." |
| 0:40 to 0:45 | The agent's hand-off summary, then an end card | "Free on Agensi. MIT licensed. github.com/AlleyBo55/VoiceBridge" |

## Screenshots

Use these files from `public/screenshots/`, in this order. They show VoiceBridge 1.0.0; label them as such or retake them from a current build, because the newer engines and models are not visible in them.

| Order | File | Shows | Suggested caption |
|---|---|---|---|
| 1 (cover) | `public/screenshots/1.png` | Main window, Indonesian to Korean, "Virtual mic ready" with the microphone name for each OS | Pick your languages. Meeting apps use the virtual mic. |
| 2 | `public/screenshots/3.png` | Settings: masked ElevenLabs and LLM keys, the note that keys are encrypted and stored only on the device, provider and model | Your keys stay on your device, encrypted. |
| 3 | `public/screenshots/4.png` | Settings: real microphone input, voice detection sensitivity, push-to-talk mode, the active voice clone, the voice clone prompt | Clone your own voice once. Push-to-talk prevents feedback. |
| 4 | `public/screenshots/2.png` | Main window with the language list open | Any supported language pair. |

`4.png` shows the first characters of an ElevenLabs voice ID. It is not a secret, but crop it if you prefer. A fifth image of the doctor's terminal output would show what the skill itself does; take one during the demo recording.

## Pre-submission checklist

Mapped to the points Agensi's review covers.

| Review point | How the skill meets it | Check before submitting |
|---|---|---|
| Clear SKILL.md | Spec-valid frontmatter; sections for when to use, safety rules, a numbered workflow, expectations and references; references one level deep; well under 500 lines | `node agensi/package-skill.mjs` passes; read SKILL.md from top to bottom once |
| No hidden behaviour | Every action the agent takes is written in SKILL.md. Installs happen only after the exact command is shown and approved. The doctor scripts only read. | Read both scripts and run the grep check below the table |
| No obfuscated code | Plain, commented bash and PowerShell. No encoded or minified content, no `Invoke-Expression`, no downloads, no executed `eval` | Open each file; nothing is generated |
| No undisclosed network calls | The skill makes none. The agent's network use (git, GitHub downloads, package managers, npm) is listed in the disclosure above and gated on approval. | The disclosure matches SKILL.md step 2, step 3 and safety rule 6 |
| No credential harvesting | The agent is told never to ask for, read, store or send keys; keys go only into the app. The packager rejects `.env` files and key-like strings. | The packager's secret scan passes; no file asks for a key |
| Safe, honest intent | Consent rules for voice cloning, a refusal to imitate others, and stated limits on delay, accuracy, voice likeness and Windows | Keep these sections when editing |
| Original work | Written for VoiceBridge by its author and released under MIT, like the app | Confirm you hold the rights; `metadata.author` is AlleyBo55 |
| Works on the listed tools | `doctor.sh` was run on macOS 26.2 (Apple Silicon); its Linux branch was smoke-run with simulated `pactl` output | Still to do: load the skill in Claude Code, Codex, Cursor and Gemini CLI and confirm each runs the doctor and asks before installing; run `doctor.sh` on a real Linux desktop and `doctor.ps1` on Windows (it has not been executed yet) |

Grep check for the "no hidden behaviour" row. Every match should be text inside a printed `fix:` string or a comment, never a command the script runs:

```bash
grep -nE 'curl|wget|sudo|eval|rm |Invoke-WebRequest|Invoke-Expression' agensi/voicebridge-setup/scripts/*
```

## How to submit

1. From the repository root, run `node agensi/package-skill.mjs`. It validates the skill and writes `agensi/dist/voicebridge-setup.zip` with `voicebridge-setup/` at the zip root. If validation fails, it lists the problems and writes no zip.
2. Optionally run `unzip -l agensi/dist/voicebridge-setup.zip` to see the contents.
3. Go to https://www.agensi.io/sell, sign in and create a listing.
4. Upload `agensi/dist/voicebridge-setup.zip`.
5. Fill in the form from the table above and set the price to Free.
6. Add the screenshots and the demo video.
7. Submit for review. According to agensi.io/sell, each skill goes through an automated security scan, an AI review of safety and intent, and a human check, usually within 24 to 48 hours.
8. For later versions, raise `metadata.version` in SKILL.md, run the script again and upload the new zip as an update.
