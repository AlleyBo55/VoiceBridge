# Implementation Plan: Pipeline Hardening

## Overview

Harden the VoiceBridge pipeline by introducing seven new components (PipelineOrchestrator, AudioRoutingStateMachine, PlatformAdapters, AudioBridge, DegradationManager, DemoBootstrap, CleanupSequencer), extending existing modules (AudioOutputModule, MessageBus, types), and rewriting the offscreen document and content script to use sequence-tracked utterance lifecycle, strict playback ordering, backpressure management, failure isolation, track replacement coordination, network resilience, graceful degradation, and deterministic cleanup.

## Tasks

- [ ] 1. Add new types and message bus extensions
  - [ ] 1.1 Add new types to `src/lib/types.ts`
    - Add `AudioRoutingState`, `AudioRoutingEvent`, `DegradationLevel`, `DegradationTransition`, `AudioBridgeMessage`, `CleanupTarget`, and `CleanupResult` types as defined in the design document
    - _Requirements: 8.1, 5.1, 10.5, 7.1_

  - [ ] 1.2 Add new message types to `src/lib/message-bus.ts`
    - Add `AUDIO_ROUTING_STATE_CHANGED`, `DEGRADATION_LEVEL_CHANGED`, `UTTERANCE_STATE_CHANGED`, `TRACK_INJECT`, `TRACK_RESTORE`, `TRACK_STATUS`, `AUDIO_BRIDGE_READY`, `AUDIO_BRIDGE_DISCONNECTED`, `DEMO_KEYS_POPULATED`, `EMBEDDED_KEY_EXHAUSTED`, and `CLEANUP_COMPLETE` to `MessageType` union and `MessagePayloadMap`
    - _Requirements: 1.10, 5.7, 10.5, 6.6_

- [ ] 2. Implement AudioRoutingStateMachine (`src/lib/audio-routing.ts`)
  - [ ] 2.1 Implement the pure state transition function `transitionRoutingState()`
    - Implement the state machine with four states: PASSTHROUGH, MUTED, TTS_PLAYING, BARGE_IN
    - Implement `getAudioSource()` mapping each state to its audio source
    - Implement `getEchoCancellationMode()` mapping routing states to echo cancellation modes
    - Follow the state diagram from the design: PASSTHROUGH→MUTED on session_start, MUTED→TTS_PLAYING on tts_start, TTS_PLAYING→BARGE_IN on barge_in, etc.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.8_

  - [ ]* 2.2 Write property test for audio routing state machine (Property 7)
    - **Property 7: Audio routing state machine produces only valid transitions**
    - Test that for any sequence of AudioRoutingEvents starting from PASSTHROUGH, the state is always valid and deterministic
    - Test that `getAudioSource()` maps correctly: PASSTHROUGH→mic, MUTED→silence, TTS_PLAYING→tts, BARGE_IN→mic-fade-tts
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 2.3, 2.4, 2.10**

  - [ ]* 2.3 Write property test for routing-to-echo-cancellation mapping (Property 8)
    - **Property 8: Routing state correctly maps to echo cancellation mode**
    - Test that `getEchoCancellationMode()` returns 'speaking' for MUTED and TTS_PLAYING, 'listening' for PASSTHROUGH and BARGE_IN
    - **Validates: Requirements 8.8**

- [ ] 3. Implement DegradationManager (`src/lib/degradation-manager.ts`)
  - [ ] 3.1 Implement `computeDegradationLevel()`, `isValidDegradation()`, and `getNextDegradationLevel()`
    - `computeDegradationLevel()`: full when all connected, text-only when STT+LLM connected but TTS not, transcription-only when only STT connected, passthrough when STT not connected
    - `isValidDegradation()`: degradation must follow cascade order (full→text-only→transcription-only→passthrough), upgrade can skip levels
    - `getNextDegradationLevel()`: returns the next level down in the cascade, or null for passthrough
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.10_

  - [ ]* 3.2 Write property test for degradation level computation (Property 9)
    - **Property 9: Degradation level is correctly computed from service health**
    - Test all combinations of service connection states produce the correct degradation level
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

  - [ ]* 3.3 Write property test for degradation cascade ordering (Property 10)
    - **Property 10: Degradation cascade never skips levels**
    - Test that for any sequence of service failures, degradation only steps down one level at a time
    - **Validates: Requirements 5.10**

- [ ] 4. Implement CleanupSequencer (`src/lib/cleanup-sequencer.ts`)
  - [ ] 4.1 Implement `executeCleanupSequence()` and `buildPipelineCleanupTargets()`
    - `executeCleanupSequence()`: iterate through targets in order, try/catch each, collect errors, return CleanupResult with duration
    - `buildPipelineCleanupTargets()`: build ordered list (AudioCapture → STT → Translation → TTS → AudioOutput → EchoCancellation → LatencyMonitor), skip null modules
    - _Requirements: 7.1, 7.2, 7.8, 7.10_

  - [ ]* 4.2 Write property test for cleanup resilience (Property 14)
    - **Property 14: Cleanup resilience — all steps execute regardless of failures**
    - Test that for any list of CleanupTargets where an arbitrary subset throw errors, all targets are attempted and errors are collected
    - **Validates: Requirements 7.8, 7.10**

  - [ ]* 4.3 Write property test for cleanup ordering (Property 15)
    - **Property 15: Cleanup executes in deterministic order**
    - Test that `buildPipelineCleanupTargets()` always returns targets in the correct order, skipping null modules
    - **Validates: Requirements 7.1**

- [ ] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement DemoBootstrap (`src/lib/demo-bootstrap.ts`)
  - [ ] 6.1 Implement `bootstrapDemoKeys()`, `checkEmbeddedKeyExhaustion()`, and `isDemoMode()`
    - `bootstrapDemoKeys()`: read Vite env vars (`VITE_DEMO_ELEVENLABS_KEY`, `VITE_DEMO_LLM_KEY`, `VITE_DEMO_LLM_PROVIDER`, `VITE_DEMO_OPENROUTER_MODEL`), check if user keys exist in chrome.storage, write embedded keys using Settings_Store encryption if no user keys
    - `checkEmbeddedKeyExhaustion()`: check `embeddedKeyExhausted` flag in chrome.storage.local, cache result for 6 hours
    - `isDemoMode()`: return true if demo keys are active and no user-provided keys exist
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.7, 6.8_

  - [ ]* 6.2 Write unit tests for DemoBootstrap
    - Test demo key population with mocked chrome.storage
    - Test that user-provided keys are not overwritten
    - Test embedded key exhaustion caching (6-hour TTL)
    - Test `isDemoMode()` returns correct state
    - _Requirements: 6.1, 6.2, 6.6, 6.7_

- [ ] 7. Implement AudioBridge (`src/lib/audio-bridge.ts`)
  - [ ] 7.1 Implement `AudioBridgeSender` class (offscreen side)
    - `attachPort()`: attach MessagePort from service worker
    - `sendAudioChunk()`: send PCM as Transferable ArrayBuffer (zero-copy)
    - `sendTrackCommand()`: send inject/restore/status commands, return Promise for acknowledgment
    - `syncState()`: send routing and echo state to content script
    - `isConnected()` and `close()` methods
    - _Requirements: 10.1, 10.2, 10.5, 10.6, 10.7_

  - [ ] 7.2 Implement `AudioBridgeReceiver` class (content script side)
    - `attachPort()`: attach MessagePort from service worker
    - Set up message handler dispatching to `onAudioChunk`, `onTrackCommand`, `onStateSync` callbacks
    - `sendTrackResponse()`: send acknowledgment back to offscreen
    - `isConnected()` and `close()` methods
    - _Requirements: 10.3, 10.5, 10.6, 10.7_

  - [ ]* 7.3 Write unit tests for AudioBridge
    - Test Transferable ArrayBuffer transfer (zero-copy verification)
    - Test track command acknowledgment protocol
    - Test port disconnection detection
    - _Requirements: 10.2, 10.6, 10.4_

- [ ] 8. Implement PlatformAdapter interface and concrete adapters (`src/lib/platform-adapters.ts`)
  - [ ] 8.1 Implement PlatformAdapter interface and `createPlatformAdapter()` factory
    - Define the interface with `initialize()`, `injectVirtualTrack()`, `restoreOriginalTrack()`, `isInjected()`, `destroy()`
    - Implement factory function mapping MeetingPlatform to adapter instances, returning null for 'none'
    - _Requirements: 3.1, 3.7_

  - [ ] 8.2 Implement GoogleMeetAdapter
    - Inject main-world script at document_start that intercepts `navigator.mediaDevices.getUserMedia`
    - Store original audio track reference, replace on session start via `RTCRtpSender.replaceTrack()`
    - Use `window.postMessage` with `voicebridge` source marker for communication
    - _Requirements: 3.2, 3.10_

  - [ ] 8.3 Implement TeamsAdapter and DiscordAdapter
    - Inject main-world script monitoring `RTCPeerConnection` constructor
    - Capture peer connections, use `replaceTrack()` on audio sender
    - Use `window.postMessage` with `voicebridge` source marker for communication
    - _Requirements: 3.3, 3.4, 3.10_

  - [ ] 8.4 Implement ZoomAdapter
    - Use `chrome.tabCapture.capture()` to obtain tab audio stream
    - Create AudioContext mixing node combining TTS audio with tab output
    - Route mixed audio back to the tab
    - _Requirements: 3.5_

  - [ ] 8.5 Implement GenericAdapter
    - Monitor `RTCPeerConnection` constructor in main world
    - Attempt `replaceTrack()` on any detected audio sender
    - _Requirements: 3.6_

  - [ ]* 8.6 Write property test for platform adapter factory (Property 13)
    - **Property 13: Platform adapter factory returns correct adapter type**
    - Test that for any MeetingPlatform value, `createPlatformAdapter()` returns the correct adapter type or null for 'none'
    - **Validates: Requirements 3.7**

- [ ] 9. Extend AudioOutputModule with `getMixedTrack()` method
  - Add `getMixedTrack()` to existing `AudioOutputModule` in `src/lib/audio-output.ts`
  - Return a MediaStreamTrack from a mixing node that dynamically switches between silence and TTS audio based on routing state
  - Ensure zero gaps in the audio stream sent to the meeting
  - _Requirements: 2.9, 2.3, 2.4_

- [ ] 10. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement PipelineOrchestrator (`src/lib/pipeline-orchestrator.ts`)
  - [ ] 11.1 Implement utterance lifecycle tracking and sequence ID management
    - Create `PipelineOrchestrator` class with `#utterances` Map, `#currentSequenceId` counter, `#playbackHead`
    - Implement `handleSpeechEnd()` to assign monotonically increasing sequence IDs and create PipelineUtterance records with state CAPTURED
    - Implement state transitions: CAPTURED→TRANSCRIBED→TRANSLATED→SYNTHESIZED→PLAYED, or to DROPPED from any state
    - Reset sequence counter and clear state on new session
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.12_

  - [ ] 11.2 Implement strict playback ordering and backpressure management
    - Implement `#canPlay()`: utterance N+1 cannot play until N is PLAYED or DROPPED
    - Implement `#advancePlayback()`: try to advance the playback head after each state transition
    - Implement `#enforceBackpressure()`: drop oldest unprocessed utterances when queue > 3
    - Implement bounded active utterance map (max 10 entries), evict completed utterances older than 30 seconds
    - _Requirements: 1.7, 1.8, 1.11_

  - [ ] 11.3 Implement failure isolation and per-stage timeouts
    - Implement `#setStageTimeout()` for STT (5s), Translation (3s), TTS (3s)
    - On timeout or failure, transition utterance to DROPPED with reason, continue processing subsequent utterances
    - Implement `#dropUtterance()` with reason logging
    - _Requirements: 1.9, 9.2, 9.3_

  - [ ] 11.4 Implement latency enforcement and consecutive high-latency alerting
    - Measure end-to-end latency per utterance using LatencyMonitor
    - Track consecutive high-latency utterances (>3000ms), send ERROR after 5 consecutive
    - Implement translation flush on backpressure (queue ≥ 2 pending utterances)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ] 11.5 Integrate AudioRoutingStateMachine into PipelineOrchestrator
    - Use `transitionRoutingState()` for routing state transitions on session start/stop, TTS start/end, barge-in, degradation
    - Emit `AUDIO_ROUTING_STATE_CHANGED` messages on state changes
    - Coordinate with EchoCancellationModule based on routing state
    - Ensure state transitions complete within 50ms
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ] 11.6 Integrate DegradationManager into PipelineOrchestrator
    - Implement `handleServiceStateChange()` to update service health and compute degradation level
    - Implement `#evaluateDegradation()` and `#attemptUpgrade()` for cascade transitions
    - Restore original mic track when degrading below `full`
    - Auto-upgrade within 5 seconds when services recover
    - Log every degradation transition with trigger, previous level, and new level
    - Emit `DEGRADATION_LEVEL_CHANGED` messages
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 5.9, 5.10_

  - [ ] 11.7 Integrate CleanupSequencer into PipelineOrchestrator
    - Implement `stopSession()` using `buildPipelineCleanupTargets()` and `executeCleanupSequence()`
    - Set all module references to null after cleanup
    - Complete cleanup within 1 second
    - Emit `CLEANUP_COMPLETE` message with any errors
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8, 7.10_

  - [ ] 11.8 Implement network resilience — reconnection and second-chance logic
    - Detect WebSocket disconnection within 2 seconds via heartbeat timeout
    - Implement exponential backoff reconnection (500ms base, 2x multiplier, 10s max, 5 attempts)
    - Implement second-chance reconnection after 30 seconds if first cycle fails
    - Pause session and send ERROR if second cycle also fails
    - Send CONNECTION_STATE_CHANGED messages for connecting/connected/error states
    - _Requirements: 4.3, 4.4, 4.7, 4.8, 4.9, 4.10_

  - [ ] 11.9 Emit SESSION_STATE_CHANGED messages with utterance counts
    - Send updated totalUtterances, droppedUtterances, and currentSequenceId after each state transition
    - _Requirements: 1.10_

  - [ ]* 11.10 Write property test for utterance lifecycle transitions (Property 1)
    - **Property 1: Utterance lifecycle follows valid state transitions**
    - Test that for any utterance, state transitions only follow valid paths
    - **Validates: Requirements 1.1, 1.3, 1.4, 1.5, 1.6**

  - [ ]* 11.11 Write property test for monotonic sequence IDs (Property 2)
    - **Property 2: Sequence IDs are monotonically increasing**
    - Test that for N speech-end events, IDs are exactly 1..N with no gaps or duplicates
    - **Validates: Requirements 1.2, 1.12**

  - [ ]* 11.12 Write property test for strict playback ordering (Property 3)
    - **Property 3: Strict playback ordering**
    - Test that utterance N+1 never begins playback before N reaches PLAYED or DROPPED
    - **Validates: Requirements 1.7**

  - [ ]* 11.13 Write property test for backpressure bounds (Property 4)
    - **Property 4: Backpressure bounds the unprocessed queue**
    - Test that unprocessed utterance count never exceeds 3
    - **Validates: Requirements 1.8**

  - [ ]* 11.14 Write property test for failure isolation (Property 5)
    - **Property 5: Failure isolation — failed utterances do not block the pipeline**
    - Test that failed utterances transition to DROPPED and subsequent utterances continue
    - **Validates: Requirements 1.9, 9.3**

  - [ ]* 11.15 Write property test for bounded active utterance map (Property 6)
    - **Property 6: Active utterance map is bounded**
    - Test that the active utterance map never exceeds 10 entries
    - **Validates: Requirements 1.11**

- [ ] 12. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Rewrite offscreen document (`src/offscreen/offscreen.ts`)
  - Replace ad-hoc wiring with PipelineOrchestrator instantiation and delegation
  - Wire SESSION_START to `orchestrator.startSession()`, SESSION_STOP to `orchestrator.stopSession()`
  - Initialize AudioBridgeSender and attach MessagePort from service worker
  - Forward audio chunks from PipelineOrchestrator through AudioBridgeSender
  - Handle `beforeunload` to trigger cleanup via PipelineOrchestrator
  - Preserve existing voice time tracking and demo limit logic
  - _Requirements: 1.1–1.12, 7.11, 10.1, 10.2_

- [ ] 14. Rewrite content script (`src/content/content-script.ts`)
  - [ ] 14.1 Add PlatformAdapter lifecycle management
    - On MEETING_DETECTED, instantiate the corresponding PlatformAdapter via `createPlatformAdapter()` and call `initialize()`
    - Handle initialization failure: send ERROR with domain "meeting" and code "injection-failed", display `[INJECTION FAILED]` in widget
    - On session end, call `restoreOriginalTrack()` and `destroy()` on the active adapter
    - _Requirements: 3.7, 3.8, 3.9_

  - [ ] 14.2 Add AudioBridgeReceiver for MessageChannel audio
    - Attach MessagePort from service worker
    - Route received audio chunks to PlatformAdapter for injection
    - Handle track commands (inject/restore/status) and send acknowledgment responses
    - Handle state-sync messages for routing and echo state
    - _Requirements: 10.3, 10.5, 10.6_

  - [ ] 14.3 Add RTCPeerConnection monitoring for renegotiation detection
    - Monitor `track` events and `connectionstatechange` events on the RTCPeerConnection
    - Re-apply virtual track replacement within 500ms when renegotiation or new peer connection detected
    - _Requirements: 2.6, 2.7_

  - [ ] 14.4 Add `beforeunload` handler and widget degradation status
    - On `beforeunload`, send SESSION_STOP with reason "tab-closed" to trigger cleanup
    - Call `restoreOriginalTrack()` on the active PlatformAdapter before tab unloads
    - Update floating widget with degradation level status text: `[TEXT ONLY]`, `[TRANSCRIPT ONLY]`, `[PASSTHROUGH]`
    - Update widget status icon based on routing state (microphone, muted, speaker, microphone-pulse)
    - _Requirements: 7.7, 7.9, 5.7, 8.7_

- [ ] 15. Update service worker (`src/background/service-worker.ts`)
  - [ ] 15.1 Add MessageChannel broker
    - Create MessageChannel port pairs on session start
    - Send one port to offscreen document, one to content script
    - Detect port disconnection and re-establish within 1 second
    - Close both ports on session end
    - _Requirements: 10.1, 10.4, 10.7_

  - [ ] 15.2 Add DemoBootstrap on install
    - Call `bootstrapDemoKeys()` in `runtime.onInstalled` handler
    - Send `DEMO_KEYS_POPULATED` message if demo keys were populated
    - _Requirements: 6.1, 6.2_

- [ ] 16. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. Wire onboarding and settings for demo mode
  - [ ] 17.1 Update onboarding wizard to skip API Keys step when demo keys are active
    - Check `isDemoMode()` on onboarding load
    - Skip Step 2 (API Keys) and proceed from Welcome (Step 1) to Voice Recording (Step 3)
    - Display demo mode notice during Welcome step: "Demo mode active — 5 minutes of voice translation included. Enter your own API key in Settings for unlimited usage."
    - _Requirements: 6.3, 6.4_

  - [ ] 17.2 Update settings page for demo key override and exhaustion handling
    - When user enters their own API key, overwrite demo key and switch to unlimited mode
    - Handle embedded key exhaustion (HTTP 402): set `embeddedKeyExhausted: true`, disable demo mode, prompt for personal API key
    - _Requirements: 6.5, 6.6_

- [ ] 18. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout — all implementations use TypeScript
- All new files follow kebab-case naming and colocate tests with source
