# Implementation Tasks: VoiceBridge Chrome Extension

## Task 1: Project Scaffolding and Build Configuration

- [x] Initialize npm project with `package.json` (name: voicebridge, type: module)
- [x] Create `tsconfig.json` with strict mode, ES2022 target, bundler module resolution
- [x] Create `vite.config.ts` with multi-entry build for all extension contexts (service-worker, offscreen, content-script, widget, popup, sidepanel, options, onboarding, audio-processor.worklet)
- [x] Create directory structure: `src/background/`, `src/offscreen/`, `src/content/`, `src/popup/`, `src/sidepanel/`, `src/options/`, `src/onboarding/`, `src/lib/`, `src/worklets/`, `src/styles/`
- [x] Install dependencies: `@elevenlabs/elevenlabs-js`, `lucide-static`, `vite`, `vitest`, `fast-check`, `typescript`
- [x] Create `src/manifest.json` with Manifest V3 config, permissions, content scripts, commands, CSP

## Task 2: Nothing Design System CSS Tokens and Shared Styles

- [x] Create `src/styles/tokens.css` with all CSS custom properties: color system (dark + light mode), typography scale, spacing scale, motion tokens
- [x] Create `src/styles/shared.css` with base component styles: buttons (primary/secondary/ghost pill), toggles, inputs (underline), cards, segmented progress bars, dot-grid motif
- [x] Create `src/styles/widget.css` with floating widget styles: collapsed circle, expanded card, ghost mode, roulette mode, opacity fade, draggable positioning
- [x] Load Google Fonts: Doto (variable), Space Grotesk (300-700), Space Mono (400, 700)

## Task 3: Message Bus and Inter-Context Communication

- [x] Create `src/lib/message-bus.ts` with typed `ExtensionMessage` interface, `MessageType` union, `MessagePayloadMap`, and `ExtensionContext` type
- [x] Implement `sendMessage(type, payload)` with automatic timestamp and source context detection
- [x] Implement `onMessage(type, handler)` with sender validation (`sender.id === chrome.runtime.id`)
- [x] Implement content script ↔ page bridge using `window.postMessage` with `source: 'voicebridge'` and origin checking
- [x] Implement `MessageChannel` port pair setup for high-frequency audio data transfer between offscreen and content script

## Task 4: Settings Store with Encrypted Storage

- [x] Create `src/lib/settings-store.ts` with full `SettingsSchema` interface
- [x] Implement AES-GCM-256 encryption/decryption for API keys using Web Crypto API with PBKDF2 key derivation from `chrome.runtime.id` + per-install salt
- [x] Implement `get<K>(key)` and `set<K>(key, value)` with type-safe access to `chrome.storage.local` and `chrome.storage.sync`
- [x] Implement settings migration for version upgrades
- [x] Implement `exportSettings()` and `importSettings()` (excluding API keys)
- [x] Store install ID via `crypto.randomUUID()` on first run

## Task 5: Audio Capture Module with AudioWorklet

- [x] Create `src/worklets/audio-processor.worklet.ts` with `AudioWorkletProcessor` that converts Float32 → Int16 PCM and posts via `MessagePort` with `Transferable`
- [x] Create `src/lib/audio-capture.ts` with `AudioCaptureModule` class implementing mic access, AudioWorklet setup, ring buffer chunking (250ms / 4000 samples)
- [x] Implement energy-based VAD with state machine: SILENCE → SPEECH_PENDING (300ms onset) → SPEECH → SILENCE_PENDING (800ms offset) → SILENCE
- [x] Implement noise gate with configurable threshold (default -40dB, Ghost Mode -55dB)
- [x] Implement Ghost Mode gain boost (+20dB) and high-pass filter (100Hz)
- [x] Implement mute/unmute for echo cancellation integration
- [x] Emit `onAudioChunk`, `onVADStateChange`, `onSpeechEnd` callbacks

## Task 6: Echo Cancellation State Machine

- [x] Create `src/lib/echo-cancellation.ts` with discriminated union `EchoState` type and `EchoEvent` type
- [x] Implement pure `transitionEchoState(current, event)` function with exhaustive switch
- [x] Implement `EchoCancellationModule` class that coordinates mic muting (SPEAKING/TRANSITIONING) and TTS stopping (barge-in)
- [x] Implement 200ms transition timer after TTS ends before re-enabling mic
- [x] Implement barge-in detection: VAD speech during SPEAKING → fade out TTS (50ms), cancel TTS, switch to LISTENING within 100ms
- [x] Implement Ghost Mode override: disable barge-in detection, full mic mute during SPEAKING

## Task 7: STT Client (ElevenLabs Scribe WebSocket)

- [x] Create `src/lib/stt-client.ts` with `STTClient` class and `STTConnectionState` discriminated union
- [x] Implement WebSocket connection to `wss://api.elevenlabs.io/v1/speech-to-text/stream` with config message on open
- [x] Implement single-use token acquisition via REST API (`POST /v1/speech-to-text/stream/token`)
- [x] Implement binary audio frame sending (raw PCM Int16 ArrayBuffer)
- [x] Implement `commit()` method sending `{ type: "commit" }` on VAD speech-end
- [x] Handle `transcript.partial` and `transcript.final` messages with callbacks
- [x] Implement exponential backoff reconnection: 500ms base, 2× multiplier, 10s max, 5 attempts
- [x] Implement 15-second heartbeat ping for silent disconnection detection
- [x] Implement 10-second audio buffer queue for brief disconnections

## Task 8: Translation Engine (LLM Streaming)

- [x] Create `src/lib/translation-engine.ts` with `TranslationEngine` class supporting OpenAI and Anthropic providers
- [x] Implement streaming translation via `AsyncGenerator<string>` yielding tokens as they arrive
- [x] Implement system prompt with instructions: translate naturally, preserve tone, handle idioms, output only translated text, preserve proper nouns/technical terms
- [x] Implement sliding context window (last N finalized pairs, configurable 5-20, default 10)
- [x] Implement short utterance buffering: segments < 3 words wait 1.5s for continuation
- [x] Implement preservation markers for URLs, emails, code snippets, numbers
- [x] Implement length guard: flag translations > 3× source length, re-request with "be concise"
- [x] Implement custom glossary injection into system prompt
- [x] Implement formal/informal tone setting
- [x] Handle errors: retry once after 200ms, skip on second failure, queue on 429 with Retry-After

## Task 9: TTS Client (ElevenLabs Streaming WebSocket)

- [x] Create `src/lib/tts-client.ts` with `TTSClient` class and `TTSConnectionState` discriminated union
- [x] Implement WebSocket connection to `wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input?model_id=eleven_multilingual_v2`
- [x] Send initial config with voice settings, API key, and `output_format: "pcm_24000"` on open
- [x] Implement token-by-token text streaming with `try_trigger_generation: true`
- [x] Implement `flush()` for end-of-utterance and `cancel()` for barge-in (flush + discard queue)
- [x] Handle binary audio frames (PCM Int16 24kHz) and JSON base64 audio responses
- [x] Implement long sentence splitting at clause boundaries (commas, semicolons, conjunctions) for sentences > 50 words
- [x] Implement exponential backoff reconnection matching STT client strategy
- [x] Implement 15-second heartbeat ping

## Task 10: Audio Output Module

- [x] Create `src/lib/audio-output.ts` with `AudioOutputModule` class
- [x] Implement PCM Int16 24kHz → Float32 conversion and resampling to 48kHz via `AudioContext({ sampleRate: 48000 })`
- [x] Create `MediaStreamDestination` node for virtual audio track generation
- [x] Implement `GainNode` for volume normalization (match user's average mic level from first 5s)
- [x] Implement 100ms playback buffer to prevent audio underruns
- [x] Implement 50ms fade-out for barge-in scenarios
- [x] Implement `getVirtualTrack()` returning the `MediaStreamTrack` for WebRTC injection
- [x] Implement `destroy()` to release all audio resources (tracks stopped, context closed)

## Task 11: Meeting Detector and Platform-Specific Audio Injection

- [x] Create `src/lib/meeting-detector.ts` with URL pattern matching for Google Meet, Zoom, Teams, Discord
- [x] Implement `getInjectionStrategy(platform)` returning the appropriate strategy type
- [x] Create `src/content/content-script.ts` with platform detection on load and audio injection coordination
- [x] Implement Google Meet strategy: intercept `getUserMedia` via main-world script injection (`document_start`)
- [x] Implement Teams/Discord strategy: monitor `RTCPeerConnection` constructor, `replaceTrack` on audio sender
- [x] Implement Zoom fallback: `chrome.tabCapture` API for audio mixing
- [x] Implement generic "Force Enable" mode attempting `replaceTrack` on any detected `RTCPeerConnection`
- [x] Implement track lifecycle: store original → replace with virtual → restore on session end

## Task 12: Voice Profile Management

- [x] Create `src/lib/voice-profile.ts` with `VoiceProfileState` discriminated union and `VoiceProfile` class
- [x] Implement voice sample recording with duration tracking (30s min, 2min max)
- [x] Implement sample validation: duration check, RMS noise analysis (> -30dB average)
- [x] Implement upload to ElevenLabs Voice Cloning API (`POST /v1/voices/add`)
- [x] Implement voice deletion via `DELETE /v1/voices/{voiceId}`
- [x] Implement voice preview: synthesize test phrase via REST TTS endpoint
- [x] Store voice_id encrypted in `chrome.storage.local`

## Task 13: Latency Monitor

- [x] Create `src/lib/latency-monitor.ts` with `LatencyMeasurement` interface and `LatencyMonitor` class
- [x] Implement per-stage timing marks: captureStart, captureEnd, sttEnd, translationStart, translationFirstToken, ttsFirstByte, playbackStart
- [x] Calculate per-utterance total latency and per-stage breakdown
- [x] Implement rolling average calculation over configurable window
- [x] Emit `onLatencyUpdate` callback for UI display
- [x] Store measurement history (last 100 measurements)

## Task 14: Pipeline Orchestration and Utterance Ordering

- [ ] Implement monotonically increasing sequence ID assignment in audio capture
- [ ] Implement `PipelineUtterance` tracking through stages: CAPTURED → TRANSCRIBED → TRANSLATED → SYNTHESIZED → PLAYED / DROPPED
- [ ] Implement strict ordering: never play utterance N+1 before N
- [ ] Implement backpressure: drop oldest unprocessed when queue > 3 utterances
- [ ] Implement failure handling: skip failed utterances, log reason, continue pipeline
- [ ] Wire all pipeline components together in offscreen document: AudioCapture → STT → Translation → TTS → AudioOutput

## Task 15: Service Worker (Background Orchestrator)

- [x] Create `src/background/service-worker.ts` as the session lifecycle orchestrator
- [x] Implement offscreen document creation/management (`chrome.offscreen.createDocument` with `hasDocument` check)
- [x] Implement session state persistence to `chrome.storage.session`
- [x] Implement meeting detection via tab URL monitoring (`chrome.tabs.onUpdated`)
- [x] Implement keyboard command handling (`chrome.commands.onCommand`) for Alt+T, Ctrl+Space, Ctrl+Shift+X, Alt+G, Alt+R
- [x] Implement `chrome.runtime.onUpdateAvailable` to defer updates during active sessions
- [x] Implement alarm-based periodic tasks (quota check, heartbeat monitoring)
- [x] Handle service worker wake-up: re-attach to existing offscreen document

## Task 16: Offscreen Document (Pipeline Host)

- [x] Create `src/offscreen/offscreen.html` and `src/offscreen/offscreen.ts`
- [x] Initialize all pipeline components on creation: AudioCapture, STTClient, TranslationEngine, TTSClient, AudioOutput, EchoCancellation, LatencyMonitor
- [x] Wire message bus handlers for SESSION_START, SESSION_STOP, LANGUAGE_CHANGED, SETTINGS_UPDATED
- [x] Implement audio data relay to content script via MessageChannel
- [x] Implement quota tracking: characters sent to TTS, audio seconds to STT, LLM tokens
- [x] Implement demo voice-time tracking (VAD-active time only)

## Task 17: Floating Widget (Content Script UI)

- [x] Create `src/content/widget.ts` with Shadow DOM isolation for style encapsulation
- [x] Implement collapsed state: 48×48 circle with monoline status icon (mic/globe/speaker/pause/ghost)
- [x] Implement expanded state on hover: 240×120 card with latency (Space Mono 36px), language pair, session duration, dot-grid background
- [x] Implement click-to-toggle translation pipeline
- [x] Implement draggable positioning with per-domain persistence via `chrome.storage.local`
- [x] Implement opacity fade: 30% after 5s inactivity, 100% on hover (300ms/150ms transitions)
- [x] Implement status color coding: green (<1500ms), yellow (1500-2500ms), red (>2500ms)
- [x] Implement accent red dot (6px) for active recording state
- [x] Implement error display: inline `[OFFLINE]`, `[RECONNECTING...]`, `[ERROR]` text
- [x] Implement Ghost Mode display: ghost icon at 60% opacity with pulse animation
- [x] Implement Language Roulette display: language name in Doto with fade transitions, segmented progress bar

## Task 18: Popup UI

- [x] Create `src/popup/popup.html` and `src/popup/popup.ts`
- [x] Implement main toggle switch (Nothing mechanical toggle style)
- [x] Implement source language selector with auto-detect default, search/filter, recently-used (top 3)
- [x] Implement target language selector excluding source language, same organization
- [x] Implement voice profile status display (Not Set Up / Recording / Processing / Ready / Error)
- [x] Implement real-time latency indicator with color coding (green/yellow/red)
- [x] Implement connection status indicators for STT, TTS, LLM
- [x] Implement session duration and estimated cost display
- [x] Implement demo voice-time remaining indicator (`VOICE: 1:42 LEFT`)
- [x] Implement demo limit reached card with reset countdown and BYO key option
- [x] Implement Language Roulette button
- [x] Implement Ghost Mode toggle
- [x] Render within 100ms, max 400×500px

## Task 19: Side Panel (Live Transcript)

- [x] Create `src/sidepanel/sidepanel.html` and `src/sidepanel/sidepanel.ts`
- [x] Implement two-column transcript view: original (left) + translated (right)
- [x] Implement partial transcript display with italic styling and pulsing indicator
- [x] Implement final transcript pairs with timestamps (Space Mono caption)
- [x] Implement auto-scroll to latest unless user has scrolled up
- [x] Implement "Copy All" button (formatted text to clipboard)
- [x] Implement search/filter input highlighting matches in both columns
- [x] Implement "Export Transcript" button (.txt and .srt formats)
- [x] Implement Demo Mode pipeline visualization (flow diagram with per-stage latency)
- [x] Implement Language Roulette stacked list with current-language highlighting

## Task 20: Settings/Options Page

- [x] Create `src/options/options.html` and `src/options/options.ts`
- [x] Implement API key inputs (ElevenLabs, LLM) with validation test requests and success/failure status
- [x] Implement LLM provider selection dropdown (OpenAI / Anthropic)
- [x] Implement voice profile management section: view, record, delete, preview
- [x] Implement voice tuning sliders: stability, similarity boost, style (0.0-1.0)
- [x] Implement audio settings: noise gate threshold, VAD sensitivity, echo cancellation mode
- [x] Implement translation settings: context window size, preserve technical terms toggle, custom glossary editor
- [x] Implement performance settings: latency/quality priority slider, max concurrent requests
- [x] Implement Demo Mode section with limit explanation and "Get Credits" link
- [x] Implement usage statistics: ElevenLabs characters, LLM tokens, daily history chart
- [x] Implement Export/Import settings buttons
- [x] Implement Debug Log section: scrollable, filterable, exportable (JSON)
- [x] Implement Language Roulette sequence customization
- [x] Implement Push-to-Translate hotkey configuration

## Task 21: Onboarding Wizard

- [x] Create `src/onboarding/onboarding.html` and `src/onboarding/onboarding.ts`
- [x] Implement Step 1 (Welcome): explain VoiceBridge, demo limitations (2 min / 24h), privacy notice
- [x] Implement Step 2 (API Keys): ElevenLabs key input with validation, LLM key input, "Get free credits" card linking to hackathon offer
- [x] Implement Step 3 (Voice Recording): real-time audio level meter, countdown timer, 3 reading prompts, sample validation
- [x] Implement Step 4 (Language Selection): source + target language pickers
- [x] Implement Step 5 (Test & Confirm): full pipeline test (5s capture → transcribe → translate → synthesize → playback)
- [x] Implement step validation before progression, retry/skip on failure
- [x] Store `onboardingComplete: true` on finish, auto-launch on first install

## Task 22: Demo Mode and Voice-Time Quota System

- [ ] Implement voice-time tracking: accumulate only during VAD SPEECH state, not wall-clock
- [ ] Implement 2-minute (120s) per-install limit within rolling 24-hour window
- [ ] Implement quota state machine: Available → Active → Warning30s → Warning10s → Exhausted → Cooldown → Available
- [ ] Implement BYO key detection: validate user key → switch to Unlimited mode, remove restrictions
- [ ] Implement embedded demo key assembly (obfuscated split base64 segments)
- [ ] Implement embedded key exhaustion detection (HTTP 402) with 6-hour recheck cache
- [ ] Implement reset timer: 24h from first voice-time usage in current window
- [ ] Wire quota state to UI: popup indicator, widget progress bar, limit-reached card

## Task 23: Language Roulette Feature

- [ ] Implement Language Roulette activation (button + Alt+R shortcut)
- [ ] Implement sentence capture (next spoken sentence or pre-loaded demo sample)
- [ ] Implement 10-language synthesis cycle: EN → JA → ES → AR → FR → ZH → DE → KO → PT → HI (customizable)
- [ ] Implement sequential playback with 200ms silence gaps between languages
- [ ] Implement widget display: language name in Doto with 150ms fade transitions
- [ ] Implement side panel display: stacked translations with current-language highlighting
- [ ] Implement segmented progress bar (10 segments, one per language)
- [ ] Implement completion state: `[COMPLETE]`, Replay button, Share button (clipboard text)
- [ ] Implement "Record Roulette" option capturing full output as .webm
- [ ] Ensure roulette audio plays locally only (not sent to meeting)

## Task 24: Ghost Mode Feature

- [ ] Implement Ghost Mode toggle (popup + Alt+G shortcut)
- [ ] Implement whisper capture: lower VAD threshold to -55dB, +20dB gain, high-pass filter 100Hz
- [ ] Implement TTS output at full volume regardless of whisper input
- [ ] Adjust voice settings in Ghost Mode: stability 0.7
- [ ] Implement aggressive echo cancellation: no barge-in detection, full mic mute during SPEAKING
- [ ] Implement sensitivity meter: 5-segment bar showing input level relative to whisper threshold
- [ ] Implement "too loud" warning: `[TOO LOUD — WHISPER]` when input > -20dB
- [ ] Implement first-time tooltip explaining Ghost Mode
- [ ] Implement widget ghost icon with pulse animation (opacity 40%→60%→40%, 2s cycle)

## Task 25: Quota and Usage Management

- [ ] Implement ElevenLabs subscription check at session start (`GET /v1/user/subscription`)
- [ ] Implement quota warning levels: 80% (yellow), 95% (urgent red), 100% (stop TTS, text-only mode)
- [ ] Implement per-session usage tracking: TTS characters, STT seconds, LLM tokens, estimated cost USD
- [ ] Implement daily usage history storage (last 30 days) in `chrome.storage.local`
- [ ] Display quota percentage bar and absolute numbers in popup
- [ ] Display estimated session cost in popup footer

## Task 26: Network Resilience and Graceful Degradation

- [ ] Implement connection loss detection within 2 seconds (heartbeat timeout)
- [ ] Implement automatic reconnection for all WebSocket connections within 3 seconds on network restore
- [ ] Implement STT audio buffer queue (10 seconds) during brief disconnections
- [ ] Implement graceful degradation cascade: Full → Text-Only → Transcription-Only → Passthrough
- [ ] Ensure original microphone always remains available regardless of failures
- [ ] Implement 30-second reconnection timeout → pause session, prompt user
- [ ] Implement panic button (Ctrl+Shift+X): stop all capture, close all connections, mute extension

## Task 27: Dynamic Language Support

- [ ] Implement language list fetching from ElevenLabs API (models endpoint for TTS, cached 24h)
- [ ] Implement language tier classification: 'full' (STT + TTS) vs 'text-only' (STT only)
- [ ] Implement BCP 47 language tag usage throughout
- [ ] Implement "Text Translation Mode" for languages without TTS support
- [ ] Implement language validation before session start (target language TTS-supported check)
- [ ] Cache language lists in `chrome.storage.local` with 24-hour TTL

## Task 28: Accessibility and Keyboard Shortcuts

- [ ] Register manifest commands: toggle-translation (Alt+T), push-to-translate (Ctrl+Space), panic-stop (Ctrl+Shift+X), toggle-ghost-mode (Alt+G), language-roulette (Alt+R)
- [ ] Implement full keyboard navigation in popup (Tab, Enter/Space, Escape)
- [ ] Implement keyboard navigation in side panel (arrows, Ctrl+C, Ctrl+F)
- [ ] Add ARIA labels to floating widget: `aria-label="VoiceBridge translation status: [status]"`
- [ ] Implement ARIA live regions for status change announcements
- [ ] Ensure visible focus indicators on all interactive elements
- [ ] Implement Push-to-Translate mode (audio only while Ctrl+Space held)

## Task 29: Security Hardening

- [ ] Implement API key encryption with AES-GCM-256 + PBKDF2 key derivation (100,000 iterations, SHA-256)
- [ ] Ensure API keys never sent to content scripts (offscreen/service-worker only)
- [ ] Implement message sender validation on all `chrome.runtime.onMessage` handlers
- [ ] Implement content script ↔ page message validation (origin check + source marker)
- [ ] Implement CSP: `script-src 'self'; object-src 'none'`
- [ ] Ensure no audio data persisted to disk — streaming buffers only
- [ ] Implement resource cleanup within 1 second of session end
- [ ] Implement privacy notice in onboarding

## Task 30: Testing Infrastructure

- [ ] Set up vitest configuration with TypeScript support
- [ ] Create mock utilities for `chrome.*` APIs (storage, runtime, tabs, offscreen)
- [ ] Create mock WebSocket server for STT/TTS protocol testing
- [ ] Implement Property 1: Audio Format Round-Trip (Float32 ↔ Int16 within ±1/32768)
- [ ] Implement Property 2: Audio Chunking Completeness (no samples lost/duplicated)
- [ ] Implement Property 3: Noise Gate Correctness
- [ ] Implement Property 4: VAD State Machine Hysteresis
- [ ] Implement Property 5: Echo Cancellation State Machine
- [ ] Implement Property 6: Exponential Backoff Bounds
- [ ] Implement Property 7: Translation Context Window
- [ ] Implement Property 8: Short Utterance Buffering
- [ ] Implement Property 9: Voice Sample Validation
- [ ] Implement Property 10: Long Sentence Clause Splitting
- [ ] Implement Property 11: Sample Rate Conversion Output Length
- [ ] Implement Property 12: Volume Normalization
- [ ] Implement Property 13: Meeting Platform URL Detection
- [ ] Implement Property 14: API Key Encryption Round-Trip
- [ ] Implement Property 15: Preservation Marker Detection
- [ ] Implement Property 16: Translation Length Ratio Guard
- [ ] Implement Property 17: Pipeline Ordering and Failure Resilience
- [ ] Implement Property 18: Pipeline Backpressure
- [ ] Implement Property 19: Circular Debug Log Buffer
- [ ] Implement Property 20: Language Tier Classification
- [ ] Implement Property 21: Voice-Time Accumulator and Demo Limit
