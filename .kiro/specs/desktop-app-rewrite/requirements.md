# Requirements Document: VoiceBridge Desktop App Rewrite

## Introduction

VoiceBridge is being rewritten from a Chrome Extension into a cross-platform desktop application (Electron + Preact) with a native virtual microphone driver. The Chrome Extension approach has fundamental limitations: content scripts cannot reliably inject into all meeting platforms, Chrome extensions cannot create OS-level virtual audio devices, the audio bridge between offscreen document and content script is fragile, and each meeting platform needs a custom adapter that breaks when the platform updates.

The desktop app installs a virtual microphone driver at the OS level (like OBS Virtual Camera but for audio). The user selects "VoiceBridge Mic" as their microphone in ANY meeting application — desktop apps, web apps, or mobile apps via desktop sharing. The translation pipeline (STT → LLM → TTS) is reused from the existing codebase. This approach works universally because it operates at the OS audio layer, not the browser layer.

## Glossary

- **Desktop_App**: The VoiceBridge Electron + Preact desktop application
- **Virtual_Mic_Driver**: An OS-level virtual audio device that appears as a selectable microphone in all applications, implemented as a CoreAudio HAL plugin on macOS, a WASAPI virtual audio endpoint on Windows, and a PulseAudio null sink with module-loopback on Linux
- **Real_Mic**: The user's physical microphone hardware
- **Audio_Router**: The component that captures audio from the Real_Mic, routes it through the translation pipeline, and writes the translated audio to the Virtual_Mic_Driver
- **Pipeline_Orchestrator**: The central coordination logic that tracks each utterance through stages (CAPTURED → TRANSCRIBED → TRANSLATED → SYNTHESIZED → PLAYED / DROPPED) using monotonic sequence IDs — reused from the existing Chrome extension codebase
- **STT_Client**: The component managing the WebSocket connection to ElevenLabs Scribe real-time STT — reused from the existing codebase
- **Translation_Engine**: The component that sends transcribed text to an LLM for streaming translation — reused from the existing codebase
- **TTS_Client**: The component managing the WebSocket connection to ElevenLabs streaming TTS — reused from the existing codebase
- **Echo_Cancellation_Module**: The component that prevents TTS output from being re-captured by the microphone — reused from the existing codebase
- **Latency_Monitor**: The component tracking per-stage and end-to-end pipeline latency — reused from the existing codebase
- **Degradation_Manager**: The component managing the graceful degradation cascade (full → text-only → transcription-only → passthrough) — reused from the existing codebase
- **Tray_App**: The system tray icon and menu that provides quick access to VoiceBridge controls without opening the main window
- **Main_Window**: The Preact-based popup window launched from the Tray_App, styled with the Nothing design system
- **Settings_Store**: Persistent storage for user preferences, API keys, and voice profile references, using the local filesystem with AES-GCM-256 encryption for sensitive data
- **Native_Addon**: A Node.js native addon (N-API) that interfaces with OS-level audio APIs for virtual device creation and real microphone capture
- **Driver_Installer**: The component responsible for installing, verifying, and uninstalling the Virtual_Mic_Driver, requiring elevated privileges on macOS and Windows

## Requirements

### Requirement 1: Virtual Microphone Driver Installation and Lifecycle

**User Story:** As a user, I want VoiceBridge to install a virtual microphone that appears as a selectable audio input in every application on my computer, so that I can use real-time voice translation in any meeting app without per-app configuration.

#### Acceptance Criteria

1. WHEN the Desktop_App is launched for the first time, THE Driver_Installer SHALL check whether the Virtual_Mic_Driver is installed on the operating system
2. IF the Virtual_Mic_Driver is not installed, THEN THE Driver_Installer SHALL prompt the user for elevated privileges (administrator on Windows, sudo on macOS) and install the driver
3. WHEN the Virtual_Mic_Driver is installed on macOS, THE Driver_Installer SHALL register a CoreAudio HAL plugin that creates a virtual audio device named "VoiceBridge Mic" with 1 channel, 48000 Hz sample rate, and 32-bit float format
4. WHEN the Virtual_Mic_Driver is installed on Windows, THE Driver_Installer SHALL register a WASAPI virtual audio endpoint named "VoiceBridge Mic" with 1 channel, 48000 Hz sample rate, and 16-bit PCM format
5. WHEN the Virtual_Mic_Driver is installed on Linux, THE Driver_Installer SHALL create a PulseAudio null sink named "VoiceBridge Mic" using `pactl load-module module-null-sink` and configure a module-loopback for audio routing
6. WHEN the Virtual_Mic_Driver is installed, THE Desktop_App SHALL verify the device appears in the OS audio device list by enumerating available input devices and confirming "VoiceBridge Mic" is present
7. IF the driver installation fails, THEN THE Driver_Installer SHALL display a specific error message with the OS error code and provide a "Retry" action
8. WHEN the user uninstalls the Desktop_App, THE Driver_Installer SHALL remove the Virtual_Mic_Driver and clean up all OS-level registrations
9. THE Virtual_Mic_Driver SHALL remain registered and visible to other applications even when the Desktop_App is not running, outputting silence when the app is inactive
10. WHEN the Desktop_App starts and the Virtual_Mic_Driver is already installed, THE Driver_Installer SHALL verify driver version compatibility and offer to update if a newer version is bundled with the app

### Requirement 2: Real Microphone Capture and Audio Routing

**User Story:** As a user, I want VoiceBridge to capture my real microphone audio and route it through the translation pipeline to the virtual microphone, so that meeting participants hear my translated voice when they select "VoiceBridge Mic."

#### Acceptance Criteria

1. WHEN a translation session starts, THE Audio_Router SHALL open the user's selected Real_Mic using the Native_Addon and capture audio at 16000 Hz, mono, PCM Int16 format
2. THE Audio_Router SHALL enumerate all available physical audio input devices and present them in the Main_Window for the user to select their preferred Real_Mic
3. WHEN the user has not selected a Real_Mic, THE Audio_Router SHALL use the OS default audio input device
4. THE Audio_Router SHALL buffer captured audio into 250ms chunks (4000 samples at 16kHz) before forwarding to the Pipeline_Orchestrator, matching the existing chunking strategy
5. WHILE a translation session is active, THE Audio_Router SHALL write translated TTS audio (resampled to 48kHz Float32) to the Virtual_Mic_Driver via the Native_Addon
6. WHILE a translation session is inactive, THE Audio_Router SHALL pass the Real_Mic audio directly through to the Virtual_Mic_Driver (passthrough mode) so the user's original voice is heard
7. IF the selected Real_Mic is disconnected during a session, THEN THE Audio_Router SHALL pause the session, notify the user, and attempt to switch to the OS default audio input device within 1 second
8. THE Audio_Router SHALL apply Voice Activity Detection using energy-based detection with a 300ms speech onset delay and 800ms speech offset delay, reusing the existing VAD logic
9. THE Audio_Router SHALL support a configurable noise gate threshold (default -40dB) to avoid sending silence or background noise to the STT_Client
10. WHEN the user toggles Ghost Mode, THE Audio_Router SHALL lower the noise gate threshold to -55dB and apply +20dB gain amplification to the captured audio

### Requirement 3: Translation Pipeline Integration

**User Story:** As a user, I want the desktop app to reuse the proven translation pipeline from the Chrome extension, so that I get the same quality real-time voice translation with the same latency characteristics.

#### Acceptance Criteria

1. THE Desktop_App SHALL reuse the existing Pipeline_Orchestrator module to track utterances through CAPTURED → TRANSCRIBED → TRANSLATED → SYNTHESIZED → PLAYED / DROPPED with monotonic sequence IDs
2. THE Desktop_App SHALL reuse the existing STT_Client module to connect to ElevenLabs Scribe v2 Realtime via WebSocket for speech-to-text
3. THE Desktop_App SHALL reuse the existing Translation_Engine module to translate transcripts via OpenAI, Anthropic, or OpenRouter LLM providers with streaming token output
4. THE Desktop_App SHALL reuse the existing TTS_Client module to connect to ElevenLabs streaming TTS via WebSocket for voice synthesis
5. THE Desktop_App SHALL reuse the existing Echo_Cancellation_Module with its three-state machine (LISTENING, SPEAKING, TRANSITIONING) to prevent TTS audio from being re-captured
6. THE Desktop_App SHALL reuse the existing Latency_Monitor to track per-stage latency (capture, STT, translation, TTS, routing) and end-to-end latency per utterance
7. THE Desktop_App SHALL reuse the existing Degradation_Manager to handle the graceful degradation cascade: full → text-only → transcription-only → passthrough
8. THE Desktop_App SHALL adapt the existing Audio_Output_Module to write PCM audio to the Virtual_Mic_Driver via the Native_Addon instead of routing through a WebRTC MediaStreamTrack
9. THE Pipeline_Orchestrator SHALL enforce the same per-stage timeouts as the Chrome extension: STT 5 seconds, Translation 3 seconds, TTS 3 seconds
10. THE Pipeline_Orchestrator SHALL enforce the same backpressure limits: maximum 3 unprocessed utterances in queue, maximum 10 active utterances in the tracking map

### Requirement 4: Virtual Microphone Output

**User Story:** As a user, I want the translated audio to be written to the virtual microphone device so that any meeting application that selects "VoiceBridge Mic" receives my translated voice.

#### Acceptance Criteria

1. WHEN the TTS_Client produces audio chunks (PCM Int16 at 24kHz), THE Audio_Router SHALL resample the audio to 48kHz Float32 and write it to the Virtual_Mic_Driver via the Native_Addon
2. THE Native_Addon SHALL write audio to the Virtual_Mic_Driver with a maximum latency of 10ms from the write call to the audio being available to consuming applications
3. WHILE translation is active and the Echo_Cancellation_Module is in LISTENING state (no TTS playing), THE Audio_Router SHALL write silence to the Virtual_Mic_Driver so that the user's original voice is not transmitted
4. WHILE translation is active and the Echo_Cancellation_Module is in SPEAKING state (TTS playing), THE Audio_Router SHALL write the TTS audio to the Virtual_Mic_Driver
5. WHEN barge-in is detected, THE Audio_Router SHALL fade out TTS audio over 50ms and switch to writing the Real_Mic audio directly to the Virtual_Mic_Driver within 100ms total
6. WHEN translation is inactive (passthrough mode), THE Audio_Router SHALL write the Real_Mic audio directly to the Virtual_Mic_Driver with less than 5ms additional latency
7. THE Audio_Router SHALL normalize TTS audio volume to match the user's average microphone input level, measured during the first 5 seconds of each session
8. IF the Virtual_Mic_Driver becomes unavailable (driver crash or unload), THEN THE Audio_Router SHALL detect the failure within 500ms, pause the session, and notify the user


### Requirement 5: System Tray Application and Main Window

**User Story:** As a user, I want VoiceBridge to run as a system tray application with a popup window, so that it stays out of my way during meetings but is always accessible with one click.

#### Acceptance Criteria

1. WHEN the Desktop_App starts, THE Tray_App SHALL display an icon in the OS system tray (macOS menu bar, Windows system tray, Linux system tray)
2. THE Tray_App icon SHALL indicate the current state: idle (monochrome icon), active session (icon with accent dot), error (icon with warning indicator)
3. WHEN the user clicks the Tray_App icon, THE Main_Window SHALL appear as a popup window anchored to the tray icon position, sized at 360px width × 480px height
4. THE Main_Window SHALL display a prominent on/off toggle for enabling/disabling the translation session
5. THE Main_Window SHALL display source and target language selectors with search/filter, recently-used languages (top 3), and all ElevenLabs-supported languages
6. THE Main_Window SHALL display real-time latency in Space Mono at display size, color-coded: green (< 1500ms), yellow (1500-2500ms), red (> 2500ms)
7. THE Main_Window SHALL display connection status indicators for each pipeline component (STT, TTS, LLM) using inline monospace labels
8. THE Main_Window SHALL display the current degradation level using inline status text: no indicator for full, `[TEXT ONLY]` in warning color, `[TRANSCRIPT ONLY]` in warning color, `[PASSTHROUGH]` in accent color
9. THE Main_Window SHALL display the selected Real_Mic name and a dropdown to change it without stopping the session
10. WHEN the user clicks outside the Main_Window, THE Main_Window SHALL hide (not close) to preserve state
11. THE Tray_App right-click menu SHALL provide: "Show Window", "Toggle Translation" (with current state), "Settings", "Quit"
12. THE Main_Window SHALL follow the Nothing design system: OLED black background, Space Grotesk + Space Mono font stack, three-layer visual hierarchy, mechanical toggles, no shadows

### Requirement 6: Language Selection and Voice Profile Management

**User Story:** As a user, I want to select my source and target languages and manage my voice clone profile from the desktop app, so that I can configure translation to match my needs.

#### Acceptance Criteria

1. THE Main_Window SHALL display a source language selector with "Auto-detect" as default, plus all ElevenLabs STT-supported languages (90+)
2. THE Main_Window SHALL display a target language selector with all ElevenLabs TTS-supported languages, excluding the selected source language
3. WHEN the user changes the target language during an active session, THE Translation_Engine SHALL immediately apply the new target language to subsequent utterances without restarting the session
4. THE Desktop_App SHALL cache the supported language list from the ElevenLabs API in the Settings_Store with a 24-hour TTL
5. THE Desktop_App SHALL provide a voice profile management section in Settings: view current profile status, record a new voice sample (30s minimum, 2 minutes maximum), delete profile, preview voice in target language
6. THE Desktop_App SHALL reuse the existing VoiceProfileManager for recording, validation, upload, and deletion via the ElevenLabs REST API
7. WHEN no voice profile exists, THE Desktop_App SHALL use a default ElevenLabs built-in voice for TTS synthesis
8. THE Desktop_App SHALL store the voice profile ID in the Settings_Store with AES-GCM-256 encryption
9. THE Desktop_App SHALL provide voice tuning sliders for stability (0.0-1.0), similarity boost (0.0-1.0), and style (0.0-1.0) in the Settings view
10. THE Desktop_App SHALL persist the last-used language pair across application restarts

### Requirement 7: Latency Monitoring and Debug Indicators

**User Story:** As a user, I want to see real-time latency metrics and pipeline health indicators, so that I can verify the system is performing well and diagnose issues.

#### Acceptance Criteria

1. THE Main_Window SHALL display the current end-to-end latency for the most recent utterance, updated after each utterance completes playback
2. THE Main_Window SHALL display a per-stage latency breakdown (capture, STT, translation, TTS, routing) when the user expands the latency detail view
3. THE Main_Window SHALL display the average latency over the last 10 utterances using the existing Latency_Monitor
4. IF end-to-end latency exceeds 3000ms for 5 consecutive utterances, THEN THE Desktop_App SHALL display an inline warning suggesting the user check their network connection or reduce quality settings
5. THE Main_Window SHALL display the current session statistics: total utterances, dropped utterances, session duration, and voice time used
6. THE Desktop_App SHALL provide a debug log view accessible from Settings that displays timestamped pipeline events with category, level, and metadata
7. THE Desktop_App SHALL log all pipeline events (utterance state transitions, degradation changes, connection state changes, errors) to an in-memory ring buffer of 500 entries maximum
8. THE Main_Window SHALL display the Virtual_Mic_Driver status: installed/not installed, active/inactive, current sample rate

### Requirement 8: Auto-Start on Login

**User Story:** As a user, I want VoiceBridge to optionally start automatically when I log in to my computer, so that the virtual microphone is always available when I join a meeting.

#### Acceptance Criteria

1. THE Desktop_App SHALL provide an "Auto-start on login" toggle in the Settings view, defaulting to off
2. WHEN the user enables auto-start on macOS, THE Desktop_App SHALL register a Launch Agent in `~/Library/LaunchAgents/` that starts the app on login
3. WHEN the user enables auto-start on Windows, THE Desktop_App SHALL add a registry entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` or use the Electron `app.setLoginItemSettings` API
4. WHEN the user enables auto-start on Linux, THE Desktop_App SHALL create a `.desktop` file in `~/.config/autostart/`
5. WHEN the Desktop_App starts via auto-start, THE Desktop_App SHALL launch minimized to the system tray without showing the Main_Window
6. WHEN the Desktop_App starts via auto-start, THE Desktop_App SHALL verify the Virtual_Mic_Driver is still installed and functional
7. WHEN the user disables auto-start, THE Desktop_App SHALL remove the corresponding OS-level auto-start registration

### Requirement 9: Cross-Platform Support

**User Story:** As a user, I want VoiceBridge to work on macOS, Windows, and Ubuntu, so that I can use it regardless of my operating system.

#### Acceptance Criteria

1. THE Desktop_App SHALL build and run on macOS 12 (Monterey) and later, targeting both Intel (x64) and Apple Silicon (arm64) architectures
2. THE Desktop_App SHALL build and run on Windows 10 (version 1903) and later, targeting x64 architecture
3. THE Desktop_App SHALL build and run on Ubuntu 22.04 LTS and later, targeting x64 architecture
4. THE Native_Addon SHALL compile platform-specific audio driver code using N-API with prebuild binaries for each supported OS and architecture
5. THE Desktop_App SHALL use Electron's platform detection (`process.platform`) to select the correct Virtual_Mic_Driver implementation at runtime
6. THE Desktop_App SHALL package platform-specific driver binaries within the Electron app bundle, signed appropriately for each OS
7. WHEN the Desktop_App is built for macOS, THE build process SHALL produce a signed `.dmg` installer that includes the CoreAudio HAL plugin
8. WHEN the Desktop_App is built for Windows, THE build process SHALL produce a signed `.exe` installer (NSIS or MSI) that includes the WASAPI virtual audio driver
9. WHEN the Desktop_App is built for Linux, THE build process SHALL produce a `.deb` package and an `.AppImage` that includes PulseAudio configuration scripts
10. THE Desktop_App SHALL use consistent keyboard shortcuts across platforms, substituting Cmd for Ctrl on macOS: toggle translation (Ctrl/Cmd+Shift+T), Ghost Mode (Ctrl/Cmd+Shift+G)

### Requirement 10: Privacy and Security

**User Story:** As a user, I want the same privacy guarantees as the Chrome extension — no audio storage, encrypted API keys, no telemetry — so that I can trust VoiceBridge with my conversations.

#### Acceptance Criteria

1. THE Desktop_App SHALL stream audio through the pipeline without writing any audio data to disk at any point
2. THE Desktop_App SHALL clear all transcript data from memory when a session ends
3. THE Desktop_App SHALL encrypt API keys (ElevenLabs, LLM provider) at rest using AES-GCM-256 via the Node.js crypto module, with the encryption key derived from a machine-specific identifier and a per-install salt using PBKDF2
4. THE Desktop_App SHALL store encrypted settings in a platform-appropriate config directory: `~/Library/Application Support/VoiceBridge/` on macOS, `%APPDATA%/VoiceBridge/` on Windows, `~/.config/voicebridge/` on Linux
5. THE Desktop_App SHALL not include any analytics, telemetry, crash reporting, or third-party tracking scripts
6. THE Desktop_App SHALL not transmit any data to servers other than the configured ElevenLabs API endpoints and the configured LLM API endpoint
7. THE Desktop_App SHALL provide a panic stop keyboard shortcut (Ctrl/Cmd+Shift+X) that immediately stops all audio capture, closes all WebSocket connections, clears all in-memory data, and writes silence to the Virtual_Mic_Driver
8. THE Desktop_App SHALL never expose API keys to renderer processes — all API calls SHALL happen in the Electron main process or a dedicated worker
9. WHEN the Desktop_App is uninstalled, THE uninstaller SHALL remove all stored settings, encrypted keys, and the Virtual_Mic_Driver from the system
10. THE Desktop_App SHALL validate all IPC messages between the main process and renderer process using a typed message schema to prevent injection attacks

### Requirement 11: Demo Mode with Voice-Time Limits

**User Story:** As a first-time user or hackathon judge, I want to try VoiceBridge immediately with built-in demo keys and a voice-time limit, so that I can experience the full pipeline without entering API keys.

#### Acceptance Criteria

1. WHEN the Desktop_App is launched for the first time, THE Desktop_App SHALL check for embedded demo API keys from build-time environment variables (`VITE_DEMO_ELEVENLABS_KEY`, `VITE_DEMO_LLM_KEY`, `VITE_DEMO_LLM_PROVIDER`, `VITE_DEMO_OPENROUTER_MODEL`)
2. IF embedded demo keys are present and no user-provided keys exist, THEN THE Desktop_App SHALL activate demo mode and skip the API key entry step during onboarding
3. WHILE in demo mode, THE Desktop_App SHALL enforce a 5-minute voice-time limit per 24-hour rolling window, tracking only VAD-active speech time (not wall-clock time)
4. THE Main_Window SHALL display the remaining demo voice time as a segmented progress bar with numeric readout in Space Mono
5. WHEN the demo voice-time limit is reached, THE Desktop_App SHALL stop the translation session, display a message prompting the user to enter their own API key, and switch to passthrough mode
6. WHEN the user enters their own API keys in Settings, THE Desktop_App SHALL immediately switch to unlimited mode, removing all voice-time restrictions
7. IF the embedded demo ElevenLabs key is exhausted (API returns HTTP 402), THEN THE Desktop_App SHALL disable demo mode and prompt the user to enter a personal API key
8. THE Desktop_App SHALL cache the embedded key exhaustion state and recheck only once every 6 hours
9. WHEN the `VITE_DEMO_UNLIMITED` environment variable is set to `true` at build time, THE Desktop_App SHALL bypass the voice-time limit for demo keys
10. THE embedded demo keys SHALL be injected at build time and SHALL NOT be stored as plaintext string literals in the source code

### Requirement 12: Settings Persistence and Configuration

**User Story:** As a user, I want my settings to persist across application restarts, so that I do not have to reconfigure VoiceBridge every time I launch it.

#### Acceptance Criteria

1. THE Settings_Store SHALL persist all user preferences to a JSON configuration file in the platform-appropriate config directory
2. THE Settings_Store SHALL encrypt sensitive settings (API keys) using AES-GCM-256 before writing to disk
3. THE Settings_Store SHALL store the following non-sensitive settings in plaintext JSON: source language, target language, recent languages, LLM provider, voice tuning parameters, noise gate threshold, VAD sensitivity, auto-start preference, Ghost Mode state, theme preference, selected Real_Mic device ID
4. THE Desktop_App SHALL provide a Settings view accessible from the Tray_App menu and the Main_Window, containing: API key inputs with validation, voice profile management, audio device selection, translation settings (context window size, formality level, custom glossary), performance settings, auto-start toggle, and keyboard shortcut configuration
5. THE Settings_Store SHALL provide an "Export Settings" function that exports non-sensitive settings as a JSON file (excluding API keys)
6. THE Settings_Store SHALL provide an "Import Settings" function that loads settings from a JSON file, validating the schema before applying
7. WHEN a setting is changed, THE Settings_Store SHALL write the updated configuration to disk within 1 second
8. THE Settings_Store SHALL use atomic file writes (write to temp file, then rename) to prevent corruption from crashes during write
9. THE Desktop_App SHALL apply settings changes immediately without requiring an application restart, except for Virtual_Mic_Driver changes which require a driver reload
10. THE Settings_Store SHALL migrate settings from older schema versions automatically when the app is updated
