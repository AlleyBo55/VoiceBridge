# Implementation Plan: VoiceBridge Desktop App Rewrite

## Overview

Rewrite VoiceBridge from a Chrome Extension into an Electron + Preact desktop app with an OS-level virtual microphone driver. The implementation reuses the existing translation pipeline (STT → LLM → TTS) and replaces Chrome-specific I/O with N-API native audio capture, virtual mic output, Electron IPC, and filesystem-based settings. Tasks are ordered so each step builds on the previous, with property tests placed close to the code they validate.

## Tasks

- [ ] 1. Initialize Electron project structure and build configuration
  - [ ] 1.1 Create the `desktop/` directory structure: `src/main/`, `src/renderer/`, `src/native/`, `src/shared/`, `src/preload/`, and `tests/` subdirectories (`properties/`, `unit/`, `integration/`)
    - Set up `package.json` with Electron, Preact, `napi-rs`, `vite`, `vitest`, and `fast-check` dependencies
    - Configure `tsconfig.json` for strict mode, ES2022 target, and separate configs for main/renderer/preload
    - Configure `vite` for Electron main + renderer builds
    - Configure `vitest` for the `tests/` directory
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ] 1.2 Create Electron main process entry point (`src/main/main.ts`)
    - Initialize `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, 360×480 size
    - Set up system tray with placeholder icon and context menu (Show Window, Toggle Translation, Settings, Quit)
    - Wire window show/hide on tray click and click-outside behavior
    - _Requirements: 5.1, 5.3, 5.10, 5.11_

  - [ ] 1.3 Create preload script (`src/preload/preload.ts`) with typed `contextBridge` API
    - Expose the `VoiceBridgeAPI` interface via `contextBridge.exposeInMainWorld('voicebridge', api)`
    - Include all methods: session, settings, devices, driver, voice profile, languages, debug, events
    - _Requirements: 10.8_

  - [ ] 1.4 Set up Preact renderer entry point (`src/renderer/index.tsx`) with Nothing design system CSS tokens
    - Import `tokens.css` with dark/light mode variables
    - Create root `<App />` component shell with `useReducer` for local state
    - _Requirements: 5.12_

- [ ] 2. Checkpoint — Ensure Electron app launches with tray icon and empty window
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Implement shared types and platform utilities
  - [ ] 3.1 Create shared type definitions (`src/shared/types.ts`)
    - Define `AudioDeviceInfo`, `CaptureConfig`, `DriverInstallResult`, `DriverStatus`, `AudioChunk`, `DriverManifest`, `IPCMessage`
    - Define `MainToRendererEvents` and `RendererToMainInvocations` IPC channel maps
    - Define `DesktopSettingsSchema` with all fields from the design
    - Reuse `PipelineUtterance`, `SessionState`, `LatencyMeasurement`, `EchoState`, `VADState`, `AudioRoutingState`, `DegradationLevel` from existing `src/lib/types.ts`
    - _Requirements: 3.1, 4.1, 10.10_

  - [ ] 3.2 Create platform mapping utility (`src/shared/platform.ts`)
    - Implement `getConfigDir()` returning OS-specific config path (macOS: `~/Library/Application Support/VoiceBridge/`, Windows: `%APPDATA%/VoiceBridge/`, Linux: `~/.config/voicebridge/`)
    - Implement `getDriverClass()` returning the correct driver implementation per platform
    - Implement `getKeyboardShortcut()` substituting `Cmd` for `Ctrl` on macOS
    - _Requirements: 9.5, 9.10, 10.4_

  - [ ]* 3.3 Write property test for platform mapping (Property 21)
    - **Property 21: Platform mapping returns correct OS-specific values**
    - **Validates: Requirements 9.5, 9.10, 10.4**

- [ ] 4. Implement IPC message bus and validation
  - [ ] 4.1 Create Electron IPC router (`src/main/electron-ipc.ts`)
    - Implement typed `ipcMain.handle` registrations for all `RendererToMainInvocations` channels
    - Implement typed `mainWindow.webContents.send` for all `MainToRendererEvents` channels
    - Validate all incoming IPC messages against the typed schema (channel, payload type, timestamp, nonce)
    - Reject malformed messages with logged error
    - _Requirements: 10.10_

  - [ ]* 4.2 Write property test for IPC message validation (Property 17)
    - **Property 17: IPC message validation accepts well-formed and rejects malformed messages**
    - **Validates: Requirements 10.10**

- [ ] 5. Implement Settings Store with encryption
  - [ ] 5.1 Create desktop settings store (`src/main/desktop-settings-store.ts`)
    - Implement `get`, `set`, `getAll`, `flush` using filesystem JSON in platform-appropriate config directory
    - Implement AES-GCM-256 encryption for `elevenLabsApiKey` and `llmApiKey` using Node.js `crypto`
    - Derive encryption key via PBKDF2 (100,000 iterations, SHA-256) from `os.hostname() + os.userInfo().username` + per-install random salt
    - Implement atomic writes (write to `.tmp`, then `fs.rename`)
    - _Requirements: 10.3, 10.4, 12.1, 12.2, 12.3, 12.7, 12.8_

  - [ ]* 5.2 Write property test for encryption round-trip (Property 12)
    - **Property 12: Encryption round-trip preserves plaintext**
    - **Validates: Requirements 6.8, 10.3, 12.2**

  - [ ]* 5.3 Write property test for settings persistence round-trip (Property 13)
    - **Property 13: Settings persistence round-trip**
    - **Validates: Requirements 12.1, 12.3, 6.10**

  - [ ] 5.4 Implement settings export/import (`exportSettings`, `importSettings`)
    - `exportSettings` produces JSON excluding `elevenLabsApiKey` and `llmApiKey`
    - `importSettings` validates schema before applying, rejects invalid JSON or mistyped fields
    - _Requirements: 12.5, 12.6_

  - [ ]* 5.5 Write property test for settings export excludes secrets (Property 14)
    - **Property 14: Settings export never contains sensitive fields**
    - **Validates: Requirements 12.5**

  - [ ]* 5.6 Write property test for settings import validation (Property 15)
    - **Property 15: Settings import validates schema and rejects invalid input**
    - **Validates: Requirements 12.6**

  - [ ] 5.7 Implement settings schema migration (`migrateFromVersion`)
    - Detect older schema versions and apply defaults for new fields while preserving compatible values
    - _Requirements: 12.10_

  - [ ]* 5.8 Write property test for settings migration (Property 16)
    - **Property 16: Settings migration produces valid schema**
    - **Validates: Requirements 12.10**

- [ ] 6. Checkpoint — Ensure settings store tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement Native Audio Addon interface and Audio Router
  - [ ] 7.1 Create N-API addon TypeScript interface (`src/native/native-addon.ts`)
    - Define the `NativeAudioAddon` interface with device enumeration, capture, virtual mic, and resampling methods
    - Create a mock/stub implementation for development and testing before the Rust addon is built
    - _Requirements: 2.1, 2.2, 4.1, 4.2_

  - [ ] 7.2 Implement Audio Router (`src/main/audio-router.ts`)
    - Implement `start`, `stop`, `setPassthrough`, `setCaptureDevice`, `setGhostMode`, `setNoiseGateThreshold`
    - Implement audio chunking: buffer captured PCM into 250ms chunks (4000 samples at 16kHz)
    - Implement VAD using `computeRmsDb` and `transitionVADState` (reused from existing codebase)
    - Implement noise gate filtering based on configurable threshold (default -40dB)
    - Implement Ghost Mode: lower threshold to -55dB, apply +20dB gain
    - Wire `onAudioChunk`, `onVADStateChange`, `onSpeechEnd` callbacks
    - Implement `writeTTSAudio`, `writeSilence`, `writePassthrough`, `fadeOutTTS` for virtual mic output
    - Implement passthrough mode (write real mic audio directly to virtual mic when session inactive)
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9, 2.10, 4.1, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 7.3 Write property test for audio chunking (Property 1)
    - **Property 1: Audio chunking produces fixed-size output**
    - **Validates: Requirements 2.4**

  - [ ]* 7.4 Write property test for TTS resampling (Property 2)
    - **Property 2: TTS resampling preserves sample count ratio and value range**
    - **Validates: Requirements 2.5, 4.1**

  - [ ]* 7.5 Write property test for audio routing state machine (Property 3)
    - **Property 3: Audio routing state machine transitions are deterministic and complete**
    - **Validates: Requirements 2.6, 4.3, 4.4**

  - [ ]* 7.6 Write property test for VAD state transitions (Property 4)
    - **Property 4: VAD state transitions follow onset/offset delay rules**
    - **Validates: Requirements 2.8**

  - [ ]* 7.7 Write property test for noise gate filtering (Property 5)
    - **Property 5: Noise gate rejects sub-threshold audio**
    - **Validates: Requirements 2.9**

  - [ ]* 7.8 Write property test for echo cancellation state machine (Property 6)
    - **Property 6: Echo cancellation state machine preserves transition rules**
    - **Validates: Requirements 3.5**

  - [ ]* 7.9 Write property test for volume normalization (Property 9)
    - **Property 9: Volume normalization scales TTS output to match reference level**
    - **Validates: Requirements 4.7**

- [ ] 8. Implement Desktop Pipeline Orchestrator
  - [ ] 8.1 Create desktop pipeline adapter (`src/main/desktop-pipeline.ts`)
    - Wrap existing `PipelineOrchestrator` with Electron-specific wiring
    - Replace `chrome.runtime.sendMessage` with Electron IPC event emission
    - Wire `AudioRouter` audio chunks into the pipeline
    - Wire pipeline TTS output to `AudioRouter.writeTTSAudio`
    - Enforce per-stage timeouts: STT 5s, Translation 3s, TTS 3s
    - Enforce backpressure limits: max 3 queued, max 10 active utterances
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_

  - [ ]* 8.2 Write property test for degradation level computation (Property 7)
    - **Property 7: Degradation level computation follows cascade rules**
    - **Validates: Requirements 3.7**

  - [ ]* 8.3 Write property test for backpressure queue limits (Property 8)
    - **Property 8: Backpressure queue never exceeds configured limits**
    - **Validates: Requirements 3.10**

- [ ] 9. Checkpoint — Ensure pipeline and audio router tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement Driver Installer and Auto-Start Manager
  - [ ] 10.1 Create driver installer (`src/main/driver-installer.ts`)
    - Implement `checkInstalled`, `install`, `uninstall`, `checkVersionCompatibility`, `verifyDevicePresent`
    - Handle platform-specific installation: CoreAudio HAL plugin (macOS), WASAPI endpoint (Windows), PulseAudio module (Linux)
    - Request elevated privileges via `sudo-prompt` (macOS) or Electron elevation patterns (Windows)
    - Linux: user-space PulseAudio module loading, no elevation required
    - Display OS error code on failure with retry action
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

  - [ ] 10.2 Create auto-start manager (`src/main/auto-start.ts`)
    - Implement `isEnabled`, `enable`, `disable`
    - macOS: use `app.setLoginItemSettings()` or Launch Agent in `~/Library/LaunchAgents/`
    - Windows: use `app.setLoginItemSettings()` or registry entry
    - Linux: create/remove `.desktop` file in `~/.config/autostart/`
    - Default to off
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

- [ ] 11. Implement Latency Monitor, Debug Log, and Demo Mode
  - [ ] 11.1 Adapt latency monitor for desktop (`src/main/desktop-latency.ts`)
    - Reuse existing `LatencyMonitor` for per-stage and end-to-end tracking
    - Implement latency-to-color mapping: green (< 1500ms), yellow (1500-2500ms), red (> 2500ms)
    - Implement consecutive high-latency detection: warn after 5 consecutive measurements > 3000ms
    - Emit latency updates via IPC to renderer
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 11.2 Write property test for latency-to-color mapping (Property 10)
    - **Property 10: Latency-to-color mapping follows threshold boundaries**
    - **Validates: Requirements 5.6**

  - [ ]* 11.3 Write property test for consecutive high-latency detection (Property 20)
    - **Property 20: Consecutive high-latency detection triggers at exact threshold**
    - **Validates: Requirements 7.4**

  - [ ] 11.4 Adapt debug log for desktop (`src/main/desktop-debug-log.ts`)
    - Reuse existing `DebugLog` with buffer increased to 500 entries
    - Log all pipeline events (utterance transitions, degradation changes, connection state, errors)
    - Expose via IPC for renderer debug view
    - _Requirements: 7.6, 7.7_

  - [ ]* 11.5 Write property test for debug log ring buffer (Property 19)
    - **Property 19: Debug log ring buffer never exceeds maximum size**
    - **Validates: Requirements 7.7**

  - [ ] 11.6 Implement demo mode logic (`src/main/demo-mode.ts`)
    - Check for embedded demo API keys from build-time env vars (`VITE_DEMO_ELEVENLABS_KEY`, etc.)
    - Activate demo mode when embedded keys present and no user keys exist
    - Track VAD-active speech time in a 24-hour rolling window, enforce 5-minute limit
    - Stop session and prompt for personal API key when limit reached
    - Switch to unlimited mode when user enters own keys
    - Handle embedded key exhaustion (HTTP 402), cache exhaustion state, recheck every 6 hours
    - Respect `VITE_DEMO_UNLIMITED` env var to bypass limit
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10_

  - [ ]* 11.7 Write property test for demo voice-time tracking (Property 18)
    - **Property 18: Demo voice-time tracking enforces rolling window limit**
    - **Validates: Requirements 11.3**

- [ ] 12. Checkpoint — Ensure latency, debug, and demo mode tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Implement Language Selection and Voice Profile
  - [ ] 13.1 Implement language list caching and filtering (`src/main/language-service.ts`)
    - Fetch supported languages from ElevenLabs API (STT and TTS)
    - Cache in settings store with 24-hour TTL
    - Filter target languages: exclude source language, support case-insensitive substring search
    - Track recently-used languages (top 3)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.10_

  - [ ]* 13.2 Write property test for language filtering (Property 11)
    - **Property 11: Language filtering excludes source and matches search query**
    - **Validates: Requirements 5.5, 6.2**

  - [ ] 13.3 Adapt voice profile manager for desktop (`src/main/desktop-voice-profile.ts`)
    - Reuse existing `VoiceProfileManager` for REST API calls (upload, delete, preview)
    - Replace `MediaRecorder` with N-API-based recording for voice sample capture
    - Store voice profile ID encrypted in settings store
    - Use default ElevenLabs voice when no profile exists
    - Expose voice tuning sliders (stability, similarity boost, style) via IPC
    - _Requirements: 6.5, 6.6, 6.7, 6.8, 6.9_

- [ ] 14. Implement Preact UI — Main Window
  - [ ] 14.1 Build Main Window layout and session toggle (`src/renderer/components/`)
    - Create `Header` component with logo and connection status
    - Create `SessionToggle` component (mechanical pill toggle for on/off)
    - Create `LanguagePair` component with source/target selectors, search/filter, recent languages
    - Wire to `voicebridge.startSession()` / `voicebridge.stopSession()` via contextBridge
    - _Requirements: 5.4, 5.5, 6.1, 6.2_

  - [ ] 14.2 Build latency display and pipeline status components
    - Create `LatencyDisplay` component showing end-to-end latency in Space Mono at display size, color-coded
    - Create `ConnectionStatus` component with inline monospace labels for STT/TTS/LLM
    - Create `DegradationLabel` component: no indicator for full, `[TEXT ONLY]`, `[TRANSCRIPT ONLY]`, `[PASSTHROUGH]`
    - Create `MicDevice` dropdown for selecting input device without stopping session
    - Create `DemoTimer` segmented progress bar with numeric readout
    - Listen to IPC events for real-time updates
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 7.1, 7.5, 7.8, 11.4_

  - [ ] 14.3 Build system tray integration
    - Implement state-aware tray icon: idle (monochrome), active (accent dot), error (warning indicator)
    - Implement right-click context menu: Show Window, Toggle Translation (with state), Settings, Quit
    - Anchor main window to tray icon position
    - _Requirements: 5.1, 5.2, 5.11_

- [ ] 15. Implement Preact UI — Settings Window
  - [ ] 15.1 Build Settings view (`src/renderer/components/settings/`)
    - Create `APIKeyInputs` with underline-style inputs and validation
    - Create `VoiceProfile` section: record, preview, delete, tuning sliders
    - Create `AudioDevices` input selector
    - Create `TranslationSettings`: context window size, formality level, custom glossary
    - Create `PerformanceSettings`: latency priority options
    - Create `AutoStartToggle`
    - Create `KeyboardShortcuts` configuration
    - Create `DebugLogView` ring buffer viewer
    - Wire all to contextBridge API for settings get/set
    - _Requirements: 12.4, 12.9, 6.5, 6.9, 8.1, 7.6, 9.10_

- [ ] 16. Implement Privacy and Security features
  - [ ] 16.1 Implement panic stop and session cleanup (`src/main/panic-stop.ts`)
    - Register global keyboard shortcut `Ctrl/Cmd+Shift+X`
    - Execute deterministic cleanup: stop capture, disconnect STT/TTS/LLM WebSockets, write silence to virtual mic, clear all in-memory transcripts and audio buffers, clear latency monitor, emit session state changed
    - Each step try/catch wrapped — failures logged but don't block subsequent steps
    - _Requirements: 10.7_

  - [ ] 16.2 Implement session privacy guarantees
    - Ensure no audio data is written to disk at any point (streaming only)
    - Clear all transcript data from memory on session end
    - Ensure API keys never leave main process — all API calls in main process only
    - _Requirements: 10.1, 10.2, 10.5, 10.6, 10.8_

- [ ] 17. Wire all components together
  - [ ] 17.1 Wire IPC handlers to all backend services in main process
    - Connect `session:start` / `session:stop` to `DesktopPipeline` + `AudioRouter`
    - Connect `settings:*` handlers to `DesktopSettingsStore`
    - Connect `devices:*` handlers to `NativeAudioAddon` device enumeration
    - Connect `driver:*` handlers to `DriverInstaller`
    - Connect `voice:*` handlers to `DesktopVoiceProfile`
    - Connect `languages:list` to `LanguageService`
    - Connect `debug:get-log` to `DesktopDebugLog`
    - Forward all `MainToRendererEvents` from pipeline/audio/driver to renderer
    - _Requirements: 3.1, 3.8, 5.9, 6.3, 12.9_

  - [ ] 17.2 Implement mic disconnection recovery
    - Detect selected mic disconnection during active session
    - Pause session, notify user via IPC, attempt fallback to OS default device within 1 second
    - _Requirements: 2.7_

  - [ ] 17.3 Implement driver failure detection
    - Monitor virtual mic driver status, detect failure within 500ms
    - Pause session and notify user on driver crash or unload
    - _Requirements: 4.8_

- [ ] 18. Implement build and packaging configuration
  - [ ] 18.1 Configure Electron Builder for cross-platform packaging
    - macOS: signed `.dmg` with CoreAudio HAL plugin, x64 + arm64
    - Windows: signed `.exe` (NSIS) with WASAPI driver, x64
    - Linux: `.deb` + `.AppImage` with PulseAudio scripts, x64
    - Bundle platform-specific driver binaries within the app
    - Configure `napi-rs` prebuild for each OS/arch target
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 9.8, 9.9_

  - [ ] 18.2 Configure uninstaller to remove driver and settings
    - Remove Virtual_Mic_Driver and OS-level registrations
    - Remove stored settings and encrypted keys from config directory
    - _Requirements: 1.8, 10.9_

- [ ] 19. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The existing pipeline modules (`STTClient`, `TranslationEngine`, `TTSClient`, `EchoCancellationModule`, `LatencyMonitor`, `DegradationManager`, `CleanupSequencer`) are reused unchanged — only the I/O layer is replaced
- The N-API native addon (Rust/napi-rs) requires separate compilation per platform; the TypeScript interface + mock is created first to unblock all other work
