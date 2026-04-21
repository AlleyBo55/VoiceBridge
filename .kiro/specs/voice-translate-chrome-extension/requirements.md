# Requirements Document: VoiceBridge — Real-Time Voice Translation Chrome Extension

## Introduction

VoiceBridge is a Chrome Extension that enables real-time voice translation during browser-based meetings. The extension captures the user's microphone audio, transcribes speech using ElevenLabs Real-time STT (Scribe), translates the transcript via an LLM, and re-synthesizes the translated text using ElevenLabs streaming TTS with the user's own cloned voice. The translated audio is then injected back into the meeting so other participants hear the user speaking fluently in the target language.

The system operates as a pipeline: Audio Capture → Speech-to-Text → Translation → Text-to-Speech → Audio Output, with an end-to-end latency target of under 2 seconds.

## Glossary

- **Extension**: The VoiceBridge Chrome Extension, a Manifest V3 Chrome extension
- **Service_Worker**: The background service worker that maintains persistent WebSocket connections and orchestrates the translation pipeline
- **Content_Script**: JavaScript injected into meeting pages to handle audio capture and output routing
- **Popup_UI**: The extension popup interface for controls and status display
- **Side_Panel**: The Chrome side panel showing live transcripts and conversation history
- **Audio_Capture_Module**: The component responsible for capturing microphone audio via Web Audio API
- **STT_Client**: The component managing the WebSocket connection to ElevenLabs Scribe real-time STT
- **Translation_Engine**: The component that sends transcribed text to an LLM for translation
- **TTS_Client**: The component managing the connection to ElevenLabs streaming TTS API
- **Audio_Output_Module**: The component that routes synthesized audio back into the meeting as virtual microphone input
- **Voice_Profile**: A stored ElevenLabs voice clone ID created from the user's voice sample
- **VAD**: Voice Activity Detection — algorithm that detects when the user is speaking vs silent
- **Echo_Cancellation_Module**: The component that prevents TTS output from being re-captured by the microphone input
- **Session**: An active translation session from when the user toggles on until toggle off or meeting ends
- **Transcript_Store**: In-memory storage of original and translated transcript segments during a session
- **Settings_Store**: Persistent storage for user preferences, API keys, and voice profile references
- **Onboarding_Wizard**: The first-time setup flow guiding users through API key entry, voice recording, and language selection
- **Latency_Monitor**: The component tracking end-to-end pipeline latency and displaying it to the user
- **Meeting_Detector**: The component that identifies which meeting platform is active on the current tab
- **PCM_16**: Pulse-code modulation 16-bit audio format required by ElevenLabs STT
- **WebRTC**: Web Real-Time Communication protocol used by meeting platforms for audio/video
- **Nothing_Design_System**: The UI design language used throughout the extension — monochrome, typographic, industrial aesthetic inspired by Nothing Technology's visual language, Swiss typography, and Braun/Teenage Engineering industrial design. Characterized by: OLED blacks, Space Grotesk + Space Mono + Doto font stack, three-layer visual hierarchy, mechanical controls, segmented progress bars, and single-accent-per-screen color discipline

## Requirements

### Requirement 1: Chrome Extension Architecture and Manifest V3 Compliance

**User Story:** As a developer, I want the extension to be built on Manifest V3 architecture, so that it complies with Chrome Web Store policies and has access to modern extension APIs.

#### Acceptance Criteria

1. THE Extension SHALL use a Manifest V3 manifest.json with `"manifest_version": 3`
2. THE Extension SHALL declare a background service worker in the manifest using the `"background"` field with `"service_worker"` key
3. THE Extension SHALL declare content scripts in the manifest targeting meeting platform URLs (meet.google.com, zoom.us, teams.microsoft.com, discord.com)
4. THE Extension SHALL declare the following permissions: `"permissions": ["activeTab", "sidePanel", "storage", "tabCapture", "offscreen"]`
5. THE Extension SHALL declare the following host permissions: `"host_permissions": ["https://meet.google.com/*", "https://zoom.us/*", "https://teams.microsoft.com/*", "https://discord.com/*", "https://api.elevenlabs.io/*"]`
6. THE Extension SHALL include a popup HTML page referenced in `"action.default_popup"`
7. THE Extension SHALL include a side panel HTML page registered via the `chrome.sidePanel` API
8. THE Extension SHALL include an options page for advanced settings referenced in `"options_page"`
9. WHEN the Service_Worker is terminated by Chrome due to inactivity, THE Service_Worker SHALL re-establish all active WebSocket connections within 1 second of being reawakened
10. THE Extension SHALL use an offscreen document to maintain persistent WebSocket connections that survive service worker termination

### Requirement 2: Microphone Audio Capture

**User Story:** As a user, I want the extension to capture my microphone audio reliably, so that my speech can be transcribed and translated in real-time.

#### Acceptance Criteria

1. WHEN the user toggles translation on, THE Audio_Capture_Module SHALL request microphone access via `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 } })`
2. THE Audio_Capture_Module SHALL capture audio in PCM_16 format at 16000 Hz sample rate as required by ElevenLabs Scribe
3. THE Audio_Capture_Module SHALL buffer audio into chunks of 250ms (4000 samples at 16kHz) before sending to the STT_Client
4. WHILE a Session is active, THE Audio_Capture_Module SHALL continuously stream audio chunks to the STT_Client without gaps or dropped frames
5. THE Audio_Capture_Module SHALL use a Web Audio API AudioWorkletProcessor for low-latency audio processing on a dedicated audio thread
6. IF the microphone permission is denied, THEN THE Extension SHALL display a clear error message in the Popup_UI explaining how to grant microphone permission
7. IF the microphone stream is interrupted (device disconnected), THEN THE Audio_Capture_Module SHALL pause the Session and notify the user within 500ms
8. THE Audio_Capture_Module SHALL apply a noise gate with a configurable threshold (default -40dB) to avoid sending silence or background noise to the STT_Client
9. THE Audio_Capture_Module SHALL implement Voice Activity Detection using energy-based detection with a 300ms speech onset delay and 800ms speech offset delay
10. WHEN VAD detects speech has ended, THE Audio_Capture_Module SHALL signal the STT_Client to commit the current utterance

### Requirement 3: Echo Cancellation and Feedback Prevention

**User Story:** As a user, I want the extension to prevent the translated TTS audio from being re-captured by my microphone, so that infinite feedback loops do not occur.

#### Acceptance Criteria

1. WHILE the Audio_Output_Module is playing TTS audio, THE Echo_Cancellation_Module SHALL mute the audio capture pipeline to prevent re-capture of synthesized speech
2. THE Echo_Cancellation_Module SHALL implement a state machine with three states: LISTENING (mic active, TTS silent), SPEAKING (mic muted, TTS playing), and TRANSITIONING (200ms buffer between states)
3. WHEN the TTS audio playback completes, THE Echo_Cancellation_Module SHALL wait 200ms before re-enabling microphone capture to account for acoustic echo tail
4. THE Echo_Cancellation_Module SHALL use the browser's built-in echo cancellation (`echoCancellation: true` constraint) as a first layer of protection
5. IF the user speaks while TTS is still playing (barge-in), THEN THE Echo_Cancellation_Module SHALL immediately stop TTS playback and switch to LISTENING state within 100ms
6. THE Echo_Cancellation_Module SHALL track TTS audio output levels and subtract the expected echo signature from the captured microphone signal as a secondary cancellation layer

### Requirement 4: Real-Time Speech-to-Text via ElevenLabs Scribe

**User Story:** As a user, I want my speech to be transcribed in real-time with low latency, so that translation can begin as quickly as possible.

#### Acceptance Criteria

1. THE STT_Client SHALL establish a WebSocket connection to the ElevenLabs Scribe real-time STT endpoint at `wss://api.elevenlabs.io/v1/speech-to-text/stream`
2. WHEN a Session starts, THE STT_Client SHALL obtain a single-use authentication token via the ElevenLabs REST API (`POST /v1/speech-to-text/stream/token`)
3. THE STT_Client SHALL send the initial configuration message with `{"type": "config", "encoding": "pcm_16000", "language_code": "<source_language>", "model": "scribe_v1"}`
4. WHILE receiving audio chunks from the Audio_Capture_Module, THE STT_Client SHALL forward each chunk as a binary WebSocket frame without additional encoding
5. THE STT_Client SHALL handle partial transcript events (type: "transcript.partial") by displaying them in the Side_Panel with visual distinction from final transcripts
6. WHEN a final transcript event (type: "transcript.final") is received, THE STT_Client SHALL immediately forward the finalized text to the Translation_Engine
7. THE STT_Client SHALL achieve a latency of less than 500ms from speech end to final transcript receipt
8. IF the WebSocket connection drops, THEN THE STT_Client SHALL attempt reconnection with exponential backoff (initial delay 500ms, max delay 10s, max 5 attempts)
9. IF reconnection fails after 5 attempts, THEN THE STT_Client SHALL notify the user via the Popup_UI and pause the Session
10. THE STT_Client SHALL send a commit message (`{"type": "commit"}`) when VAD signals end of utterance to force finalization of the current transcript segment
11. WHEN the source language is set to "auto", THE STT_Client SHALL use ElevenLabs language detection and report the detected language in the Side_Panel
12. THE STT_Client SHALL handle the `"end_of_stream"` message by gracefully closing the WebSocket and finalizing any pending transcript

### Requirement 5: LLM-Based Translation

**User Story:** As a user, I want my transcribed speech to be translated accurately and naturally into my target language, so that other meeting participants can understand me.

#### Acceptance Criteria

1. WHEN a final transcript segment is received from the STT_Client, THE Translation_Engine SHALL send it to the configured LLM API (OpenAI GPT-4o or Claude 3.5 Sonnet) for translation
2. THE Translation_Engine SHALL use a system prompt that instructs the LLM to: translate naturally (not literally), preserve tone and intent, handle idioms appropriately, maintain technical terminology, and output only the translated text without explanations
3. THE Translation_Engine SHALL maintain a sliding context window of the last 10 transcript segments (original + translated) to provide conversational context for coherent translation
4. THE Translation_Engine SHALL use streaming responses from the LLM API to begin forwarding translated text to the TTS_Client before the full translation is complete
5. THE Translation_Engine SHALL achieve a translation latency of less than 300ms from transcript receipt to first translated token
6. THE Extension SHALL support translation between ALL languages supported by ElevenLabs STT (90+ languages) — the LLM translation layer SHALL handle any source-to-target language pair without artificial restrictions
7. IF the LLM API returns an error, THEN THE Translation_Engine SHALL retry once after 200ms, and if the retry fails, skip the segment and log the error
8. IF the LLM API rate limit is exceeded (HTTP 429), THEN THE Translation_Engine SHALL queue segments and retry after the `Retry-After` header duration
9. THE Translation_Engine SHALL include the source language and target language in every API request to avoid ambiguity
10. THE Translation_Engine SHALL handle partial sentences by buffering segments shorter than 3 words and combining them with the next segment before translating
11. WHEN the user changes the target language mid-session, THE Translation_Engine SHALL immediately apply the new target language to subsequent segments without restarting the Session
12. THE Translation_Engine SHALL preserve proper nouns, brand names, and technical acronyms without translation by including them in the system prompt instructions

### Requirement 6: Voice Cloning and Profile Management

**User Story:** As a user, I want the translated speech to sound like my own voice, so that meeting participants recognize me and the experience feels natural.

#### Acceptance Criteria

1. THE Onboarding_Wizard SHALL guide the user through recording a voice sample of 30 seconds minimum and 2 minutes maximum duration
2. WHEN the voice sample recording is complete, THE Extension SHALL upload the audio to the ElevenLabs Voice Cloning API (`POST /v1/voices/add`) with the parameters `{"name": "VoiceBridge-<user_id>", "labels": {"source": "voicebridge"}}`
3. THE Extension SHALL store the returned voice_id in Settings_Store using `chrome.storage.local` with encryption via the Web Crypto API
4. THE Extension SHALL display the voice profile status (created, pending, ready) in the Popup_UI
5. WHEN the user requests to delete their voice profile, THE Extension SHALL call the ElevenLabs API (`DELETE /v1/voices/<voice_id>`) and remove the local reference
6. THE Extension SHALL allow the user to re-record their voice sample to create an updated voice profile
7. IF the voice cloning API returns an error during profile creation, THEN THE Extension SHALL display the specific error message and offer to retry
8. THE Extension SHALL validate that the voice sample meets minimum quality requirements (sample length >= 30s, no excessive background noise detected via RMS analysis > -30dB average)
9. THE Extension SHALL provide a "Preview Voice" button that synthesizes a short test phrase in the target language using the cloned voice so the user can verify quality before using it in a meeting


### Requirement 7: Streaming Text-to-Speech with Cloned Voice

**User Story:** As a user, I want the translated text to be spoken aloud in my cloned voice with minimal delay, so that the conversation flows naturally.

#### Acceptance Criteria

1. WHEN translated text is received from the Translation_Engine, THE TTS_Client SHALL send it to the ElevenLabs Streaming TTS API via WebSocket (`wss://api.elevenlabs.io/v1/text-to-speech/<voice_id>/stream-input`)
2. THE TTS_Client SHALL use the user's cloned voice_id from Settings_Store for all synthesis requests
3. THE TTS_Client SHALL configure voice settings with defaults: `{"stability": 0.5, "similarity_boost": 0.75, "style": 0.3, "use_speaker_boost": true}`
4. THE TTS_Client SHALL allow the user to adjust stability (0.0-1.0), similarity_boost (0.0-1.0), and style (0.0-1.0) via the Settings page
5. THE TTS_Client SHALL stream translated text token-by-token to the TTS WebSocket to minimize time-to-first-audio-byte
6. THE TTS_Client SHALL achieve a latency of less than 300ms from first translated text token to first audio byte received
7. THE TTS_Client SHALL request audio output in PCM format at 24000 Hz sample rate for high-quality playback
8. WHEN a long sentence (> 50 words) is being synthesized, THE TTS_Client SHALL split it at natural clause boundaries (commas, semicolons, conjunctions) and synthesize each clause separately for faster initial output
9. THE TTS_Client SHALL send a flush signal to the TTS WebSocket when the Translation_Engine signals end of a complete utterance
10. IF the TTS WebSocket connection drops, THEN THE TTS_Client SHALL reconnect within 1 second and resume from the last unspoken text segment
11. THE TTS_Client SHALL select the appropriate TTS model based on target language: `eleven_multilingual_v2` for all supported languages
12. THE TTS_Client SHALL handle the `"audio"` response messages by immediately forwarding audio chunks to the Audio_Output_Module for playback

### Requirement 8: Audio Output and Meeting Integration

**User Story:** As a user, I want the translated audio to be injected into the meeting so other participants hear my translated speech instead of my original speech.

#### Acceptance Criteria

1. THE Audio_Output_Module SHALL create a virtual audio source using the Web Audio API (MediaStreamDestination node) that can be used as a microphone input by the meeting platform
2. THE Audio_Output_Module SHALL route TTS audio chunks through an AudioContext with proper sample rate conversion from 24000 Hz (TTS output) to the meeting platform's expected rate (typically 48000 Hz)
3. WHEN TTS audio is ready to play, THE Audio_Output_Module SHALL replace the user's microphone MediaStream track in the meeting's RTCPeerConnection with the virtual audio source track
4. WHILE TTS audio is playing, THE Audio_Output_Module SHALL mute the user's original microphone track in the meeting to prevent overlapping audio
5. WHEN TTS playback completes, THE Audio_Output_Module SHALL restore the user's original microphone track within 200ms
6. THE Audio_Output_Module SHALL maintain audio quality by using a buffer of 100ms to prevent audio underruns and glitches
7. IF the meeting platform does not support track replacement (fallback scenario), THEN THE Audio_Output_Module SHALL use the `tabCapture` API to mix TTS audio into the tab's audio output
8. THE Audio_Output_Module SHALL normalize TTS audio volume to match the user's average microphone input level (measured during the first 5 seconds of the session)
9. WHEN the user speaks before TTS playback completes (barge-in detected), THE Audio_Output_Module SHALL fade out TTS audio over 50ms and immediately restore the original microphone track
10. THE Audio_Output_Module SHALL handle WebRTC codec compatibility by encoding output audio in Opus format at 48kbps to match standard WebRTC audio parameters

### Requirement 9: Extension Popup User Interface

**User Story:** As a user, I want a simple popup interface to control the extension, so that I can quickly toggle translation, select languages, and monitor status.

#### Acceptance Criteria

1. THE Popup_UI SHALL display a prominent on/off toggle switch for enabling/disabling the translation pipeline
2. THE Popup_UI SHALL display a source language selector with "Auto-detect" as default, plus ALL ElevenLabs STT-supported languages (90+), organized by: recently used languages (top 3), then alphabetical with a search/filter input for quick selection
3. THE Popup_UI SHALL display a target language selector with ALL ElevenLabs TTS-supported languages, excluding the selected source language, organized identically with search/filter and recently-used prioritization
4. THE Popup_UI SHALL display the current voice profile status with one of: "Not Set Up", "Recording...", "Processing...", "Ready", or "Error"
5. THE Popup_UI SHALL display a real-time latency indicator showing the current end-to-end pipeline latency in milliseconds, color-coded: green (< 1500ms), yellow (1500-2500ms), red (> 2500ms)
6. THE Popup_UI SHALL display the current session duration and estimated API credits consumed
7. WHEN the user clicks the toggle while no voice profile exists, THE Popup_UI SHALL redirect the user to the Onboarding_Wizard
8. THE Popup_UI SHALL display connection status indicators for each pipeline component (STT: connected/disconnected, TTS: connected/disconnected, LLM: connected/disconnected)
9. THE Popup_UI SHALL persist the last-used language pair selection across browser sessions using Settings_Store
10. THE Popup_UI SHALL render within 100ms of being opened and occupy no more than 400px width × 500px height

### Requirement 10: Side Panel Live Transcript View

**User Story:** As a user, I want to see a live transcript of my original speech and its translation side-by-side, so that I can verify accuracy and review the conversation.

#### Acceptance Criteria

1. THE Side_Panel SHALL display a scrolling transcript view with two columns: original text (left) and translated text (right)
2. WHEN a partial transcript is received from the STT_Client, THE Side_Panel SHALL display it in the original column with italic styling and a pulsing indicator
3. WHEN a final transcript and its translation are available, THE Side_Panel SHALL display both as a completed pair with timestamp
4. THE Side_Panel SHALL auto-scroll to the latest transcript entry unless the user has manually scrolled up
5. THE Side_Panel SHALL display a "Copy All" button that copies the full transcript (original + translated) to the clipboard in a formatted text layout
6. THE Side_Panel SHALL display speaker labels ("You") for the user's transcripts
7. WHILE a Session is active, THE Side_Panel SHALL retain all transcript pairs in the Transcript_Store (in-memory only, cleared on session end)
8. THE Side_Panel SHALL display a search/filter input that highlights matching text in both columns
9. THE Side_Panel SHALL indicate translation confidence by showing a subtle background color (green for high confidence, yellow for uncertain translations based on LLM response metadata)
10. WHEN the session ends, THE Side_Panel SHALL offer an "Export Transcript" button that downloads the conversation as a .txt or .srt file

### Requirement 11: In-Page Floating Status Widget (Nothing Design Language)

**User Story:** As a user, I want a minimal, beautifully designed floating indicator on the meeting page following the Nothing design language (monochrome, typographic, industrial), so that I know the system is working without opening the popup and the UI feels premium and distinctive.

#### Acceptance Criteria

1. WHEN a Session is active, THE Content_Script SHALL inject a floating widget in the bottom-right corner of the meeting page, styled according to the Nothing design system: OLED black background (`#000000`), `1px solid #222222` border, 12px border-radius, no shadows
2. THE floating widget collapsed state SHALL be a 48px × 48px circle with `--surface` background (`#111111`), `1px solid #333333` border, containing a single monoline icon (1.5px stroke, no fill, Lucide icon set) in `--text-primary` (`#E8E8E8`)
3. THE floating widget SHALL display animated status using monoline icons: microphone icon (LISTENING state), globe icon (TRANSLATING state), speaker icon (SPEAKING TTS state), pause icon (PAUSED state) — all icons 24×24px, 1.5px stroke, round caps/joins, inheriting `--text-primary` color
4. THE floating widget SHALL be draggable to any position on the page and remember its position per-domain using `chrome.storage.local`
5. WHEN the user hovers over the floating widget, THE widget SHALL expand to a 240px × 120px card with the following Nothing design layout:
   - Background: `--surface` (`#111111`), border: `1px solid #333333`, border-radius: 12px
   - Primary layer: current latency displayed in Space Mono at `--display-md` size (36px), `--text-display` (`#FFFFFF`), with "ms" unit in `--label` size (11px) adjacent
   - Secondary layer: source→target language pair in Space Grotesk at `--body-sm` (14px), `--text-primary` (`#E8E8E8`)
   - Tertiary layer: session duration in Space Mono ALL CAPS at `--caption` (12px), `--text-secondary` (`#999999`), letter-spacing 0.04em
   - Latency value color-coded using Nothing status colors: `--success` (`#4A9E5C`) for < 1500ms, `--warning` (`#D4A843`) for 1500-2500ms, `--accent` (`#D71921`) for > 2500ms — color applied to the VALUE only, not labels
6. WHEN the user clicks the floating widget, THE widget SHALL toggle the translation pipeline on/off with a mechanical toggle animation (200ms ease-out, no spring/bounce)
7. THE floating widget SHALL not interfere with the meeting platform's UI elements (z-index: 2147483640, below modals at 2147483647)
8. IF the meeting page uses a Content Security Policy that blocks inline styles, THEN THE Content_Script SHALL inject styles via a CSS file declared in the manifest's `content_scripts.css` array
9. THE floating widget SHALL fade to 30% opacity after 5 seconds of no interaction using a 300ms ease-out transition, and restore to 100% on hover within 150ms
10. THE floating widget SHALL use the Nothing design three-layer visual hierarchy: ONE primary element (the latency number or status icon), supporting context (language pair), and metadata (session duration) — never more than three layers
11. THE floating widget SHALL use a dot-grid background pattern (`radial-gradient(circle, #333333 0.5px, transparent 0.5px)`, `background-size: 12px 12px`, opacity 0.15) as a subtle decorative element in the expanded state
12. THE floating widget status transitions SHALL use opacity fades (150-250ms) rather than position animations — elements fade in/out, never slide
13. THE floating widget SHALL display connection errors using inline status text in Space Mono: `[OFFLINE]`, `[RECONNECTING...]`, `[ERROR]` — never toast popups or alert banners, following Nothing anti-patterns
14. THE floating widget active/recording state SHALL show a single `--accent` (`#D71921`) dot (6px circle) as the "one moment of surprise" — the only color accent on the widget, indicating live translation is active

### Requirement 12: Settings and Configuration Page

**User Story:** As a user, I want a comprehensive settings page to configure API keys, voice settings, and advanced options, so that I can customize the extension to my needs.

#### Acceptance Criteria

1. THE Settings page SHALL provide input fields for: ElevenLabs API key, LLM API key (OpenAI or Anthropic), and LLM provider selection (dropdown)
2. THE Settings page SHALL validate API keys by making a test request to each service and displaying success/failure status
3. THE Settings page SHALL provide voice profile management: view current profile, record new sample, delete profile, preview voice
4. THE Settings page SHALL provide voice tuning sliders for: stability (0.0-1.0), similarity boost (0.0-1.0), style exaggeration (0.0-1.0)
5. THE Settings page SHALL provide audio settings: noise gate threshold (-60dB to -20dB), VAD sensitivity (low/medium/high), echo cancellation mode (auto/aggressive/off)
6. THE Settings page SHALL provide translation settings: context window size (5-20 segments), preserve technical terms toggle, custom terminology glossary (user-defined term pairs)
7. THE Settings page SHALL provide performance settings: latency priority vs quality priority slider, max concurrent API requests (1-3)
8. THE Settings page SHALL store all settings in `chrome.storage.local` and sync non-sensitive settings via `chrome.storage.sync`
9. THE Settings page SHALL provide an "Export Settings" and "Import Settings" button for backup/restore (excluding API keys)
10. THE Settings page SHALL display current API usage statistics: ElevenLabs characters used/remaining, LLM tokens used this session, estimated cost


### Requirement 13: First-Time Onboarding Wizard

**User Story:** As a new user, I want a guided setup experience, so that I can configure the extension correctly without technical knowledge.

#### Acceptance Criteria

1. WHEN the extension is installed and opened for the first time, THE Onboarding_Wizard SHALL launch automatically as a full-page tab
2. THE Onboarding_Wizard SHALL consist of 5 sequential steps: Welcome → API Keys → Voice Recording → Language Selection → Test & Confirm
3. THE Onboarding_Wizard SHALL validate each step before allowing progression to the next step
4. WHEN the user enters API keys (Step 2), THE Onboarding_Wizard SHALL verify connectivity to ElevenLabs and the LLM provider before proceeding
5. WHEN the user records a voice sample (Step 3), THE Onboarding_Wizard SHALL display a real-time audio level meter, a countdown timer, and spoken prompts (e.g., "Please read the following paragraph aloud...")
6. THE Onboarding_Wizard SHALL provide at least 3 different reading prompts in the user's selected source language to ensure diverse phoneme coverage in the voice sample
7. WHEN the voice sample is recorded, THE Onboarding_Wizard SHALL upload it to ElevenLabs and wait for voice profile creation (displaying a progress indicator)
8. WHEN language selection is complete (Step 4), THE Onboarding_Wizard SHALL allow the user to select both a primary source language and a primary target language
9. WHEN the Test & Confirm step (Step 5) is reached, THE Onboarding_Wizard SHALL run a full pipeline test: capture 5 seconds of speech → transcribe → translate → synthesize → play back, and display the result
10. IF any step fails during onboarding, THEN THE Onboarding_Wizard SHALL display a specific error message with a "Retry" button and a "Skip" option (where safe to skip)
11. THE Onboarding_Wizard SHALL store completion status so it does not re-launch on subsequent extension opens

### Requirement 14: Network Resilience and Error Recovery

**User Story:** As a user, I want the extension to handle network issues gracefully, so that temporary connectivity problems don't permanently disrupt my meeting.

#### Acceptance Criteria

1. IF the network connection is lost during a Session, THEN THE Extension SHALL display a "Connection Lost" indicator in the floating widget and Popup_UI within 2 seconds
2. WHEN network connectivity is restored, THE Extension SHALL automatically re-establish all WebSocket connections (STT, TTS) within 3 seconds without user intervention
3. THE STT_Client SHALL implement a message queue that buffers up to 10 seconds of audio during brief disconnections and replays them upon reconnection
4. IF a WebSocket connection fails to re-establish after 30 seconds, THEN THE Extension SHALL pause the Session and prompt the user to manually resume
5. THE Translation_Engine SHALL implement request timeout of 5 seconds per translation request, after which the segment is skipped and logged
6. IF the ElevenLabs API returns HTTP 401 (unauthorized), THEN THE Extension SHALL prompt the user to re-enter their API key via the Settings page
7. IF the ElevenLabs API returns HTTP 429 (rate limited), THEN THE Extension SHALL display remaining cooldown time and queue pending requests
8. THE Extension SHALL log all errors to an in-memory circular buffer (last 100 errors) accessible via the Settings page "Debug Log" section
9. WHEN an unrecoverable error occurs (API key invalid, quota exhausted), THE Extension SHALL gracefully stop the Session, restore the original microphone, and display a clear error message
10. THE Extension SHALL implement a heartbeat ping every 15 seconds on each WebSocket connection to detect silent disconnections

### Requirement 15: Meeting Platform Detection and Compatibility

**User Story:** As a user, I want the extension to work seamlessly across different meeting platforms, so that I can use it regardless of which tool my team uses.

#### Acceptance Criteria

1. THE Meeting_Detector SHALL identify the active meeting platform by matching the current tab URL against known patterns: `meet.google.com/*`, `zoom.us/wc/*`, `teams.microsoft.com/*`, `discord.com/channels/*`
2. WHEN a supported meeting platform is detected, THE Content_Script SHALL adapt its audio routing strategy to the platform-specific DOM structure and WebRTC implementation
3. FOR Google Meet, THE Content_Script SHALL intercept the `getUserMedia` call to inject the virtual audio source as the microphone track
4. FOR Zoom Web Client, THE Content_Script SHALL use the `tabCapture` API combined with audio mixing since Zoom's WebRTC implementation restricts track replacement
5. FOR Microsoft Teams Web, THE Content_Script SHALL hook into the Teams media stack by replacing the audio track on the active RTCPeerConnection
6. FOR Discord Web, THE Content_Script SHALL replace the audio input track via the WebRTC RTCPeerConnection `replaceTrack` method
7. IF the current tab is not a recognized meeting platform, THEN THE Extension SHALL display "No supported meeting detected" in the Popup_UI and disable the toggle
8. THE Meeting_Detector SHALL re-evaluate platform detection when the tab URL changes (e.g., user joins a meeting from a lobby page)
9. FOR generic WebRTC platforms not in the known list, THE Extension SHALL provide a "Force Enable" option that attempts the standard `replaceTrack` approach
10. THE Content_Script SHALL not inject any elements or modify the page DOM until the user explicitly enables translation for that tab

### Requirement 16: Performance and Resource Management

**User Story:** As a user, I want the extension to be lightweight and not degrade my meeting experience, so that I can use it without performance concerns.

#### Acceptance Criteria

1. WHILE a Session is active, THE Extension SHALL consume less than 200MB of RAM across all extension contexts (service worker + offscreen document + content script + popup)
2. WHILE a Session is active, THE Extension SHALL consume less than 15% CPU on a modern machine (Intel i5 10th gen or equivalent) during steady-state operation
3. THE Audio_Capture_Module SHALL process audio in an AudioWorklet to avoid blocking the main thread
4. THE Extension SHALL use SharedArrayBuffer or MessageChannel for zero-copy audio data transfer between the AudioWorklet and the main thread where supported
5. THE Transcript_Store SHALL limit stored transcript pairs to the last 500 entries to prevent unbounded memory growth
6. WHEN the extension tab is not visible (backgrounded), THE Extension SHALL reduce Side_Panel update frequency from real-time to batched updates every 2 seconds
7. THE Extension SHALL release all audio resources (MediaStream tracks, AudioContext nodes) within 1 second of a Session ending
8. THE Latency_Monitor SHALL measure and report: STT latency (speech-end to transcript), translation latency (transcript to first translated token), TTS latency (text to first audio byte), and total end-to-end latency
9. THE Extension SHALL target a total end-to-end latency of less than 2000ms with the following budget: STT 500ms + Translation 300ms + TTS 300ms + Audio routing 100ms + Buffer/overhead 800ms
10. IF end-to-end latency exceeds 3000ms for 5 consecutive utterances, THEN THE Extension SHALL display a warning suggesting the user check their network connection or reduce quality settings

### Requirement 17: Security and Privacy

**User Story:** As a user, I want my audio data and API keys to be handled securely, so that my private conversations and credentials are protected.

#### Acceptance Criteria

1. THE Extension SHALL store API keys in `chrome.storage.local` encrypted using the Web Crypto API with AES-GCM-256, keyed to the user's Chrome profile
2. THE Extension SHALL never persist raw audio data to disk — all audio processing occurs in-memory streaming buffers only
3. WHEN a Session ends, THE Extension SHALL clear all audio buffers and release all MediaStream references within 1 second
4. WHILE the translation toggle is OFF, THE Audio_Capture_Module SHALL not access the microphone and no audio data SHALL be captured or transmitted
5. THE Extension SHALL communicate with ElevenLabs and LLM APIs exclusively over HTTPS (TLS 1.2 or higher)
6. THE Extension SHALL declare a strict Content Security Policy in the manifest: `"content_security_policy": {"extension_pages": "script-src 'self'; object-src 'none'"}`
7. THE Extension SHALL not include any third-party analytics, tracking, or telemetry libraries
8. WHEN the user deletes their voice profile, THE Extension SHALL confirm deletion of the remote voice clone via the ElevenLabs API and verify the deletion was successful
9. THE Extension SHALL display a clear privacy notice during onboarding explaining: what data is sent to external APIs, that audio is streamed and not stored, and that the voice profile is stored on ElevenLabs servers
10. IF the user revokes microphone permission via Chrome settings during a Session, THEN THE Extension SHALL immediately stop all audio processing and end the Session gracefully within 500ms
11. THE Extension SHALL implement a "Panic Button" (keyboard shortcut Ctrl+Shift+X) that immediately stops all audio capture, closes all API connections, and mutes the extension

### Requirement 18: Multi-Speaker Discrimination

**User Story:** As a user in a meeting with multiple speakers, I want the extension to only translate MY speech and not other participants' audio, so that the translation pipeline processes only my voice.

#### Acceptance Criteria

1. THE Audio_Capture_Module SHALL capture audio exclusively from the user's local microphone input and SHALL NOT process audio from the meeting's incoming audio stream (other participants)
2. THE Extension SHALL use `getUserMedia` for the user's microphone only, and SHALL NOT use `getDisplayMedia` or tab audio capture for input to the STT pipeline
3. IF the user's microphone picks up ambient speech from other participants (e.g., in a shared room), THEN THE VAD SHALL rely on proximity-based volume thresholds to prioritize the primary speaker (loudest source)
4. THE Extension SHALL provide a "Push-to-Translate" mode as an alternative to always-on, where translation only occurs while the user holds a configurable hotkey (default: Ctrl+Space)
5. WHEN in Push-to-Translate mode, THE Audio_Capture_Module SHALL only send audio to the STT_Client while the hotkey is held down

### Requirement 19: Quota and Usage Management

**User Story:** As a user, I want to monitor my API usage and be warned before I run out of credits, so that I can manage costs and avoid unexpected service interruptions.

#### Acceptance Criteria

1. THE Extension SHALL query the ElevenLabs API (`GET /v1/user/subscription`) at Session start to retrieve current character usage and quota limits
2. THE Extension SHALL display remaining ElevenLabs characters in the Popup_UI as a percentage bar and absolute number
3. WHEN ElevenLabs character usage exceeds 80% of the quota, THE Extension SHALL display a warning notification in the Popup_UI
4. WHEN ElevenLabs character usage exceeds 95% of the quota, THE Extension SHALL display an urgent warning and suggest the user end the session to avoid mid-conversation cutoff
5. IF the ElevenLabs quota is exhausted during a Session (HTTP 402 or quota error), THEN THE Extension SHALL immediately notify the user, stop TTS synthesis, and continue displaying transcripts and translations in text-only mode
6. THE Extension SHALL track per-session usage: total characters sent to TTS, total audio seconds processed by STT, total LLM tokens consumed, and estimated cost in USD
7. THE Extension SHALL store daily usage history (last 30 days) in `chrome.storage.local` and display it as a chart in the Settings page
8. THE Extension SHALL support a "BYO API Key" model where users provide their own ElevenLabs and LLM API keys with no additional usage restrictions from the extension

### Requirement 20: Tab Lifecycle and Extension Update Handling

**User Story:** As a user, I want the extension to handle browser lifecycle events gracefully, so that tab hibernation or extension updates don't corrupt my active session.

#### Acceptance Criteria

1. WHEN Chrome suspends a tab (Tab Discard), THE Extension SHALL detect the `document.visibilityState` change and save the current Session state (language pair, transcript history, connection status) to `chrome.storage.session`
2. WHEN a discarded tab is restored, THE Extension SHALL restore the Session state and prompt the user to resume translation
3. IF the extension is updated while a Session is active, THEN THE Extension SHALL use the `chrome.runtime.onUpdateAvailable` event to defer the update until the Session ends
4. WHEN the user closes the meeting tab during an active Session, THE Extension SHALL clean up all resources (close WebSockets, release audio streams, clear buffers) via the `beforeunload` event handler
5. IF the Service_Worker is terminated by Chrome (idle timeout), THEN THE offscreen document SHALL maintain WebSocket connections and the Service_Worker SHALL re-attach to them upon reawakening
6. THE Extension SHALL persist critical Session metadata (start time, language pair, total utterances) in `chrome.storage.session` so it survives service worker restarts
7. WHEN the user navigates away from the meeting page and returns, THE Content_Script SHALL re-inject the floating widget and re-establish audio routing within 2 seconds

### Requirement 21: Keyboard Shortcuts and Accessibility

**User Story:** As a user, I want keyboard shortcuts and accessible controls, so that I can operate the extension efficiently without relying solely on mouse interaction.

#### Acceptance Criteria

1. THE Extension SHALL register the following default keyboard shortcuts via the manifest `"commands"` field: Toggle translation (Alt+T), Push-to-translate hold (Ctrl+Space), Panic stop (Ctrl+Shift+X)
2. THE Extension SHALL allow users to customize keyboard shortcuts via Chrome's built-in extension shortcut settings (chrome://extensions/shortcuts)
3. THE Popup_UI SHALL be fully navigable via keyboard (Tab key for focus, Enter/Space for activation, Escape to close)
4. THE Side_Panel SHALL support keyboard navigation for scrolling (Arrow keys), copying (Ctrl+C on selected text), and search (Ctrl+F to focus search input)
5. THE floating widget SHALL be accessible via screen readers with appropriate ARIA labels: `aria-label="VoiceBridge translation status: [current status]"`
6. THE Extension SHALL announce status changes (translation started, translation stopped, error occurred) via ARIA live regions for screen reader users
7. ALL interactive elements in the Extension SHALL have visible focus indicators meeting WCAG 2.1 AA contrast requirements

### Requirement 22: Translation Context and Quality

**User Story:** As a user, I want translations to be contextually accurate and maintain conversational coherence, so that my translated speech makes sense to other participants throughout the meeting.

#### Acceptance Criteria

1. THE Translation_Engine SHALL prepend the last 10 finalized transcript pairs (source + translation) as context in each LLM request to maintain conversational coherence
2. THE Translation_Engine SHALL include a "meeting context" field in the system prompt that the user can optionally fill in (e.g., "This is a technical discussion about cloud architecture") to improve domain-specific translation accuracy
3. WHEN the user defines custom terminology in the Settings page glossary, THE Translation_Engine SHALL include those term pairs in the system prompt as mandatory translation mappings
4. THE Translation_Engine SHALL detect and preserve code snippets, URLs, email addresses, and numerical data without translation by wrapping them in preservation markers before sending to the LLM
5. THE Translation_Engine SHALL handle sentence fragments gracefully by buffering incomplete thoughts (detected via lack of sentence-ending punctuation from STT) and combining them before translation
6. IF the LLM returns a translation that is more than 3x the length of the source text, THEN THE Translation_Engine SHALL flag it as potentially erroneous and request a re-translation with a "be concise" instruction
7. THE Translation_Engine SHALL support a "formal" vs "informal" tone setting that adjusts the system prompt to produce appropriately formal or casual translations (relevant for languages with formal/informal registers like Japanese, Korean, German)

### Requirement 23: Audio Format Pipeline and Codec Management

**User Story:** As a developer, I want clear audio format specifications at each pipeline stage, so that audio data flows correctly without format mismatches or quality degradation.

#### Acceptance Criteria

1. THE Audio_Capture_Module SHALL output audio in PCM 16-bit signed integer format at 16000 Hz mono (required by ElevenLabs Scribe)
2. THE TTS_Client SHALL receive audio from ElevenLabs in PCM 16-bit signed integer format at 24000 Hz mono
3. THE Audio_Output_Module SHALL resample TTS audio from 24000 Hz to 48000 Hz using a high-quality sinc interpolation resampler before routing to WebRTC
4. THE Audio_Output_Module SHALL convert the resampled PCM audio to Float32 format for Web Audio API AudioBuffer compatibility
5. THE Audio_Capture_Module SHALL use an AudioWorkletProcessor that converts Float32 samples from the Web Audio API to Int16 PCM before sending to the STT_Client
6. IF the user's microphone provides audio at a sample rate other than 16000 Hz, THEN THE Audio_Capture_Module SHALL resample to 16000 Hz using the Web Audio API's built-in resampling (AudioContext sampleRate parameter)
7. THE Audio_Output_Module SHALL encode output audio compatible with the Opus codec at 48kbps as used by WebRTC peer connections in meeting platforms


### Requirement 24: Barge-In and Interruption Handling

**User Story:** As a user, I want to be able to interrupt myself or start speaking again naturally, so that the extension handles conversational dynamics without awkward delays or overlaps.

#### Acceptance Criteria

1. WHEN the user begins speaking while TTS is still playing a previous translation, THE Extension SHALL detect the barge-in within 100ms via VAD activation
2. WHEN a barge-in is detected, THE Audio_Output_Module SHALL immediately fade out the current TTS playback over 50ms and restore the original microphone track
3. WHEN a barge-in is detected, THE TTS_Client SHALL send a cancel/flush message to the TTS WebSocket to stop generating audio for the interrupted segment
4. THE Extension SHALL discard any queued but unspoken TTS audio segments when a barge-in occurs
5. WHEN the user pauses mid-sentence for more than 2 seconds and then continues, THE STT_Client SHALL treat the continuation as part of the same utterance if no commit signal was sent
6. IF the user speaks a very short utterance (< 1 second, < 3 words transcribed), THEN THE Translation_Engine SHALL buffer it and wait up to 1.5 seconds for additional speech before translating, to avoid translating fragments like "um" or "so"
7. THE Extension SHALL handle rapid back-and-forth speaking patterns (user speaks, pauses 1s, speaks again) by queuing translations and playing them sequentially without overlap

### Requirement 25: Offline Graceful Degradation

**User Story:** As a user, I want the extension to degrade gracefully when services are unavailable, so that I understand what's happening and can still participate in my meeting.

#### Acceptance Criteria

1. IF the ElevenLabs STT service is unavailable, THEN THE Extension SHALL display "Transcription unavailable" and disable the translation pipeline while keeping the user's original microphone active
2. IF the LLM translation service is unavailable, THEN THE Extension SHALL continue transcribing and display transcripts in the Side_Panel without translation, with a "Translation offline" indicator
3. IF the ElevenLabs TTS service is unavailable, THEN THE Extension SHALL continue transcribing and translating, displaying translated text in the Side_Panel, with a "Voice synthesis offline" indicator
4. IF all external services are unavailable, THEN THE Extension SHALL display "All services offline — your microphone is active normally" and ensure the user's original audio continues to flow to the meeting unmodified
5. WHEN a previously unavailable service comes back online, THE Extension SHALL automatically resume the full pipeline within 5 seconds and notify the user via the floating widget
6. THE Extension SHALL never prevent the user from speaking in a meeting — if any component fails, the original microphone audio SHALL always remain available to the meeting platform

### Requirement 26: Data Flow Integrity and Pipeline Ordering

**User Story:** As a developer, I want the translation pipeline to maintain strict ordering of utterances, so that translated speech is played back in the correct sequence.

#### Acceptance Criteria

1. THE Extension SHALL assign a monotonically increasing sequence number to each utterance as it enters the STT stage
2. THE Translation_Engine SHALL process utterances in sequence order and SHALL NOT reorder translations even if a later utterance translates faster than an earlier one
3. THE TTS_Client SHALL synthesize and play audio segments in strict sequence order, queuing later segments if an earlier segment is still being synthesized
4. IF an utterance fails at any pipeline stage (STT timeout, translation error, TTS failure), THEN THE Extension SHALL skip that utterance, log the failure, and continue with the next utterance without blocking the pipeline
5. THE Extension SHALL maintain a pipeline state for each utterance: CAPTURED → TRANSCRIBED → TRANSLATED → SYNTHESIZED → PLAYED, visible in the debug log
6. WHEN the pipeline has more than 3 utterances queued (backpressure), THE Extension SHALL skip the oldest unprocessed utterances and log them as "dropped due to backpressure" to maintain real-time responsiveness

### Requirement 27: Extension Installation and Update Flow

**User Story:** As a user, I want a smooth installation experience and non-disruptive updates, so that I can start using the extension quickly and updates don't interrupt my meetings.

#### Acceptance Criteria

1. WHEN the extension is first installed, THE Extension SHALL open the Onboarding_Wizard in a new tab automatically
2. THE Extension SHALL display a badge on the extension icon ("!") when setup is incomplete (missing API keys or voice profile)
3. WHEN an extension update is available during an active Session, THE Extension SHALL defer the update using `chrome.runtime.onUpdateAvailable` and apply it only after the Session ends
4. WHEN an extension update is applied, THE Extension SHALL migrate any stored settings from the previous version's schema to the new version's schema without data loss
5. THE Extension SHALL display a "What's New" notification after an update is applied, summarizing changes relevant to the user
6. THE Extension SHALL include a version number display in the Settings page and Popup_UI footer

### Requirement 28: Logging and Diagnostics

**User Story:** As a user or developer, I want access to diagnostic information, so that I can troubleshoot issues and report bugs effectively.

#### Acceptance Criteria

1. THE Extension SHALL maintain an in-memory circular log buffer of the last 200 events (connections, errors, latency measurements, state transitions)
2. THE Extension SHALL provide a "Debug" section in the Settings page that displays the log buffer in a scrollable, filterable view
3. THE Extension SHALL provide an "Export Debug Log" button that downloads the log buffer as a JSON file with timestamps, event types, and relevant metadata
4. THE Extension SHALL log the following events: WebSocket connect/disconnect, API request/response status codes, audio pipeline state changes, latency measurements per utterance, error details with stack traces
5. THE Extension SHALL NOT log any transcript content, translated text, or audio data in the debug log to protect user privacy
6. WHEN an error occurs that the user should act on, THE Extension SHALL display a user-friendly error message (not raw error codes) with a suggested action

### Requirement 29: Supported Language Configuration and Extensibility

**User Story:** As a user, I want the extension to support ALL languages available on ElevenLabs with no artificial limitations, so that I can translate to and from any language the platform supports.

#### Acceptance Criteria

1. THE Extension SHALL support ALL languages available on ElevenLabs Scribe STT for input (90+ languages as of 2026, including but not limited to: English, Spanish, French, German, Japanese, Mandarin Chinese, Korean, Arabic, Portuguese, Hindi, Italian, Dutch, Polish, Russian, Turkish, Vietnamese, Thai, Indonesian, Malay, Swedish, Norwegian, Danish, Finnish, Czech, Slovak, Hungarian, Romanian, Bulgarian, Croatian, Serbian, Slovenian, Lithuanian, Latvian, Estonian, Ukrainian, Belarusian, Georgian, Armenian, Azerbaijani, Kazakh, Uzbek, Persian, Urdu, Punjabi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Nepali, Sinhala, Burmese, Khmer, Lao, Tagalog, Cebuano, Javanese, Swahili, Amharic, Somali, Hausa, Yoruba, Igbo, Zulu, Afrikaans, Welsh, Irish, Icelandic, Luxembourgish, Catalan, Galician, Basque, Hebrew, Greek, Albanian, Macedonian, Bosnian, Maltese)
2. THE Extension SHALL support ALL languages available on ElevenLabs TTS for output (32+ languages supported by `eleven_multilingual_v2` and expanding with newer models like Eleven v3 supporting 74+ languages)
3. THE Extension SHALL dynamically fetch the list of supported languages from the ElevenLabs API at startup and cache it locally, rather than hardcoding a fixed list, so new languages are automatically available as ElevenLabs adds them
4. THE Extension SHALL support any-to-any translation between all supported languages — the LLM translation layer imposes no language pair restrictions
5. THE Extension SHALL use BCP 47 language tags internally for all language identification
6. WHEN the user selects "Auto-detect" for source language, THE STT_Client SHALL pass `language_code: "auto"` to ElevenLabs Scribe and display the detected language in the Popup_UI
7. THE Extension SHALL validate that the selected target language is supported by the active ElevenLabs TTS model before starting a Session, and display a clear message if the language is STT-supported but not yet TTS-supported
8. IF a language pair is not well-supported by the LLM (detected via consistently poor translation quality), THEN THE Extension SHALL display a warning: "Translation quality for [source]→[target] may be limited"
9. THE Extension SHALL organize languages in the UI dropdown by: recently used (top), then alphabetical, with a search/filter input for quick selection given the large number of options
10. THE Extension SHALL display language support tiers in the UI: "Full Support" (STT + Translation + TTS available), "Text Only" (STT + Translation available but TTS not available for this language — translated text shown in Side_Panel only), so users understand what to expect
11. WHEN a user selects a target language that is supported by STT and LLM translation but NOT by TTS, THE Extension SHALL offer a "Text Translation Mode" that displays translated text in the Side_Panel without voice synthesis, rather than blocking the user entirely

### Requirement 30: Demo Mode and Hackathon Presentation Support

**User Story:** As a hackathon presenter, I want a demo mode that showcases the extension's capabilities clearly, so that judges can see the full pipeline in action.

#### Acceptance Criteria

1. THE Extension SHALL provide a "Demo Mode" toggle in the Settings page that enables enhanced visual feedback for presentation purposes
2. WHILE Demo Mode is active, THE Side_Panel SHALL display the pipeline stages visually: a flow diagram showing Audio → STT → Translation → TTS → Output with real-time latency numbers at each stage
3. WHILE Demo Mode is active, THE floating widget SHALL expand to a larger size (200px × 100px) showing the current pipeline stage with animated transitions
4. THE Extension SHALL provide a "Simulate" button in Demo Mode that plays a pre-recorded audio sample through the pipeline to demonstrate functionality without requiring a live meeting
5. WHILE Demo Mode is active, THE Extension SHALL display character-by-character streaming of both transcription and translation in the Side_Panel for dramatic visual effect
6. THE Extension SHALL include a pre-configured demo with English→Spanish translation using a sample voice profile for zero-setup demonstration

### Requirement 31: Nothing Design System — Global UI Standards

**User Story:** As a user, I want the entire extension UI to follow the Nothing design language (monochrome, typographic, industrial aesthetic inspired by Swiss typography and Braun/Teenage Engineering industrial design), so that the extension feels premium, distinctive, and cohesive across all surfaces.

#### Acceptance Criteria

##### Typography
1. ALL Extension UI surfaces (Popup_UI, Side_Panel, Settings page, Onboarding_Wizard, floating widget) SHALL use the following font stack: Display text uses "Doto" (variable dot-matrix, Google Fonts), Body/UI text uses "Space Grotesk" (weight 300-700), Data/Labels use "Space Mono" (monospace) — all loaded via Google Fonts CDN
2. THE Extension SHALL enforce the Nothing type scale: `--display-xl` 72px, `--display-lg` 48px, `--display-md` 36px, `--heading` 24px, `--subheading` 18px, `--body` 16px, `--body-sm` 14px, `--caption` 12px, `--label` 11px ALL CAPS with 0.08em letter-spacing
3. ALL labels in the Extension SHALL be rendered in Space Mono, ALL CAPS, 11-12px, letter-spacing 0.06-0.1em, color `--text-secondary` — this is the "instrument panel" label style
4. ALL numeric data (latency, usage stats, timers, percentages) SHALL be rendered in Space Mono for tabular alignment and mechanical aesthetic
5. THE Extension SHALL use maximum 2 font families per screen (Space Grotesk + Space Mono; Doto reserved for hero moments only at 36px+), maximum 3 font sizes, and maximum 2 font weights per screen

##### Color System
6. THE Extension SHALL implement the Nothing dark mode color system as default: `--black: #000000` (OLED primary background), `--surface: #111111` (elevated cards), `--surface-raised: #1A1A1A` (secondary elevation), `--border: #222222` (subtle dividers), `--border-visible: #333333` (intentional borders), `--text-disabled: #666666`, `--text-secondary: #999999`, `--text-primary: #E8E8E8`, `--text-display: #FFFFFF`
7. THE Extension SHALL implement a light mode alternative: `--black: #F5F5F5` (off-white background), `--surface: #FFFFFF` (cards), `--surface-raised: #F0F0F0`, `--border: #E8E8E8`, `--border-visible: #CCCCCC`, `--text-disabled: #999999`, `--text-secondary: #666666`, `--text-primary: #1A1A1A`, `--text-display: #000000`
8. THE Extension SHALL use accent color `--accent: #D71921` (Nothing red) ONLY for: active recording state, destructive actions, urgent errors, and quota warnings — maximum ONE accent element per screen, never decorative
9. THE Extension SHALL use status colors applied to VALUES only (not labels or backgrounds): `--success: #4A9E5C` (connected, good latency), `--warning: #D4A843` (degraded, caution), `--accent: #D71921` (error, over limit)
10. THE Extension SHALL use `--interactive: #5B9BF6` (dark) / `#007AFF` (light) exclusively for tappable text links — never for buttons

##### Layout & Spacing
11. THE Extension SHALL use an 8px base spacing scale: 2px (optical), 4px (icon-label gaps), 8px (component internal), 16px (standard padding), 24px (group separation), 32px (section margins), 48px (major breaks), 64px (page-level rhythm)
12. THE Extension SHALL follow the Nothing three-layer visual hierarchy on every screen: Primary (ONE dominant element — large Doto/Space Mono number or headline), Secondary (supporting context in Space Grotesk body), Tertiary (metadata in Space Mono ALL CAPS at edges)
13. THE Extension SHALL prefer spacing over dividers for visual grouping — dividers (`1px solid --border`) used only in data-dense lists where items are structurally identical

##### Components
14. ALL buttons in the Extension SHALL follow Nothing button styles: Primary (pill shape 999px radius, `--text-display` background, `--black` text), Secondary (pill, transparent, `1px solid --border-visible`), Ghost (no border, `--text-secondary`) — all in Space Mono 13px ALL CAPS, letter-spacing 0.06em, min height 44px, padding 12px 24px
15. ALL toggle switches SHALL use Nothing mechanical toggle style: pill track with circle thumb, Off state (`--border-visible` track, `--text-disabled` thumb), On state (`--text-display` track, `--black` thumb), min touch target 44px
16. ALL input fields SHALL use Nothing input style: underline preferred (`1px solid --border-visible` bottom border), label above in `--label` style (Space Mono ALL CAPS `--text-secondary`), focus state border → `--text-primary`, error state border → `--accent`
17. ALL cards/surfaces SHALL use: `--surface` or `--surface-raised` background, `1px solid --border` border (or none), 12-16px border-radius, 16-24px padding, NO shadows, flat surfaces only
18. THE Extension SHALL display progress/quota using Nothing segmented progress bars: discrete rectangular segments with 2px gaps, square-ended blocks, filled segments in status color, empty segments in `--border`, always paired with numeric readout

##### Iconography
19. ALL icons in the Extension SHALL be monoline, 1.5px stroke, no fill, 24×24px base with 20×20px live area, round caps and joins, color inheriting text color — sourced from Lucide (thin variant) or Phosphor (thin variant)
20. THE Extension SHALL never use filled icons, multi-color icons, or emoji as UI elements

##### Motion & Interaction
21. ALL transitions in the Extension SHALL use 150-250ms duration for micro-interactions, 300-400ms for state transitions, with easing `cubic-bezier(0.25, 0.1, 0.25, 1)` — no spring, no bounce
22. THE Extension SHALL prefer opacity transitions over position animations — elements fade in/out, never slide
23. Hover states SHALL brighten border/text only — no scale transforms, no shadows, no color fills

##### Anti-Patterns (NEVER DO)
24. THE Extension SHALL NOT use: gradients, shadows, blur effects, skeleton loading screens, toast popups, sad-face illustrations, mascots, zebra striping, filled icons, parallax, scroll-jacking, spring/bounce easing, or border-radius > 16px on cards
25. THE Extension SHALL use inline status text for notifications: `[SAVED]`, `[ERROR: ...]`, `[CONNECTED]` in Space Mono `--caption` size near the trigger element — never floating toasts or banner alerts
26. Loading states SHALL use segmented spinner (hardware-style) or `[LOADING...]` bracket text — never skeleton screens

##### Data Visualization
27. THE Latency_Monitor display SHALL use a Nothing-style segmented progress bar showing the latency budget breakdown (STT | Translation | TTS | Routing) as discrete colored segments with numeric readout
28. THE quota/usage display SHALL use Nothing-style concentric arcs or segmented bars with the percentage as a hero number in Space Mono at `--display-lg` (48px)
29. THE Side_Panel transcript view SHALL use Nothing data row style: timestamps in Space Mono `--caption` `--text-secondary`, transcript text in Space Grotesk `--body`, dividers `1px solid --border` between entries

### Requirement 32: Language Roulette — Viral Demo Feature

**User Story:** As a hackathon presenter or user showing off the extension, I want a "Language Roulette" mode that rapidly cycles through multiple languages speaking the same sentence in my cloned voice, so that the demo creates a visually and audibly stunning moment that is instantly shareable on social media.

#### Acceptance Criteria

1. THE Extension SHALL provide a "Language Roulette" button accessible from both Demo Mode and the Popup_UI
2. WHEN Language Roulette is activated, THE Extension SHALL capture the user's next spoken sentence (or use a pre-loaded sample sentence if in Demo Mode), then automatically synthesize it in 10 consecutive languages using the user's cloned voice, playing each version back-to-back with no gap
3. THE Language Roulette sequence SHALL cycle through languages in this default order (optimized for maximum audible contrast): English → Japanese → Spanish → Arabic → French → Mandarin → German → Korean → Portuguese → Hindi — the user MAY customize this sequence in Settings
4. EACH language version in the roulette SHALL play for exactly the natural duration of the TTS output (no truncation, no padding), with a 200ms silence gap between languages for dramatic effect
5. WHILE Language Roulette is playing, THE floating widget SHALL display the current language name in Doto font at `--display-md` (36px) with a rapid fade transition (150ms) between each language, creating a visual "slot machine" effect
6. WHILE Language Roulette is playing, THE Side_Panel SHALL display all translations simultaneously in a stacked list, highlighting the currently-playing language with `--text-display` color while others remain at `--text-secondary`
7. THE Extension SHALL display a real-time progress indicator during Language Roulette: a Nothing-style segmented progress bar with 10 segments (one per language), each segment filling with `--text-display` as that language plays
8. WHEN Language Roulette completes, THE Extension SHALL display a `[COMPLETE]` status and offer a "Replay" button and a "Share" button that copies a shareable text snippet to clipboard: "I just spoke in 10 languages in 30 seconds with VoiceBridge 🌍 #ElevenHacks #CodeWithKiro"
9. THE Language Roulette SHALL complete the full 10-language cycle in under 45 seconds for a typical sentence (5-10 words), making it ideal for short-form video content
10. THE Extension SHALL allow Language Roulette to be triggered via keyboard shortcut (Alt+R) for smooth demo presentations without mouse interaction
11. WHILE Language Roulette is active, THE Extension SHALL NOT send the synthesized audio to the meeting — it plays locally only through the user's speakers/headphones (it's a demo/showcase feature, not a meeting feature)
12. THE Extension SHALL provide a "Record Roulette" option that captures the full Language Roulette audio output as a single .webm file for easy sharing on social media

### Requirement 33: Ghost Mode — Whisper-to-Full-Voice Translation

**User Story:** As a user, I want a "Ghost Mode" where I can whisper or mouth words nearly silently and the extension still captures, translates, and speaks at full volume in the target language, so that I can participate in meetings silently while others hear me clearly — creating an uncanny, magical experience.

#### Acceptance Criteria

1. THE Extension SHALL provide a "Ghost Mode" toggle in the Popup_UI and Settings page, separate from the main translation toggle
2. WHEN Ghost Mode is enabled, THE Audio_Capture_Module SHALL lower the VAD noise gate threshold to -55dB (from default -40dB) and increase microphone gain by +20dB to capture whisper-level speech
3. WHEN Ghost Mode is enabled, THE Audio_Capture_Module SHALL apply additional noise reduction processing to compensate for the increased gain (high-pass filter at 100Hz to remove room rumble, spectral gating for ambient noise)
4. THE STT_Client SHALL still receive the amplified audio and transcribe whispered speech — ElevenLabs Scribe handles low-volume input when properly amplified
5. WHEN Ghost Mode is active, THE TTS_Client SHALL synthesize the translated output at full normal volume (not whisper volume) — the output voice sounds confident and clear regardless of input volume
6. THE TTS_Client SHALL adjust voice settings in Ghost Mode: increase `stability` to 0.7 (more consistent output despite variable whisper input) and maintain `similarity_boost` at 0.75
7. WHILE Ghost Mode is active, THE floating widget SHALL display a distinctive ghost icon (a thin monoline outline, semi-transparent at 60% opacity) instead of the standard microphone icon, with a subtle pulse animation (opacity 40%→60%→40%, 2s cycle) indicating active listening
8. WHILE Ghost Mode is active, THE floating widget expanded state SHALL show the label `GHOST` in Doto font at `--display-md` with `--text-disabled` color, reinforcing the "invisible speaker" concept
9. THE Extension SHALL display a sensitivity meter in Ghost Mode showing the current input level relative to the whisper threshold, so the user knows if they're speaking loudly enough to be captured: a 5-segment horizontal bar where 1 segment = barely detected, 3 segments = good whisper level, 5 segments = speaking too loud for ghost mode
10. IF the user speaks above normal volume (-20dB) while Ghost Mode is active, THE Extension SHALL display a brief inline warning: `[TOO LOUD — WHISPER]` in the floating widget, fading after 2 seconds
11. WHEN Ghost Mode is enabled, THE Echo_Cancellation_Module SHALL be especially aggressive — since the user is whispering, any TTS playback through speakers would be easily re-captured, so the mic MUST be fully muted during TTS playback with no exceptions (no barge-in detection in Ghost Mode)
12. THE Extension SHALL allow Ghost Mode to be toggled via keyboard shortcut (Alt+G) for quick activation without opening the popup
13. WHEN Ghost Mode is first enabled, THE Extension SHALL display a one-time tooltip: "Whisper or mouth words — VoiceBridge will speak for you at full volume" to explain the feature to new users
14. THE Demo Mode SHALL include a Ghost Mode demonstration: a pre-recorded whisper sample that gets translated and spoken at full volume, with a split-screen visualization showing input waveform (tiny, whisper-level) vs output waveform (full, confident) — this visual contrast IS the viral moment

### Requirement 34: Demo Mode Voice-Time Limit and Cost Control

**User Story:** As a demo user trying VoiceBridge for the first time, I want to experience the full translation pipeline for free with a 2-minute voice-time limit, and understand how to get more usage (wait 24 hours or enter my own API key), so that the demo is accessible but the developer's credits are protected.

#### Acceptance Criteria

##### Voice-Time Tracking (Not Wall-Clock Time)
1. THE Extension SHALL track "voice time" — defined as the cumulative duration of audio segments where VAD detects active speech — separately from total session wall-clock time
2. THE Extension SHALL enforce a per-install voice-time limit of 2 minutes (120 seconds) of actual speech in demo mode — silence, pauses between sentences, and time spent listening to TTS playback do NOT count toward this limit
3. THE voice-time counter SHALL only increment while the Audio_Capture_Module is actively sending audio chunks to the STT_Client (i.e., VAD state is SPEECH), and SHALL pause during silence, TTS playback, and TRANSITIONING states
4. THE 2-minute limit is CUMULATIVE per 24-hour period — the user can split it across multiple sessions (e.g., 4 sessions of 30 seconds each), but total voice time cannot exceed 2 minutes within a rolling 24-hour window

##### User Identification (Per-Install)
5. THE Extension SHALL generate a unique install ID on first installation using `crypto.randomUUID()` and store it in `chrome.storage.local` — this identifies the install for quota tracking purposes
6. THE Extension SHALL store the cumulative voice-time usage and the timestamp of first usage in the current 24-hour window in `chrome.storage.local`, keyed to the install ID
7. THE Extension SHALL NOT require any login, account creation, or personal information to use the demo — the install ID is anonymous and local-only
8. IF the user clears extension storage or reinstalls the extension, THE quota resets (acceptable trade-off for a hackathon demo — no need for server-side tracking)

##### Time Remaining Indicator
9. THE Popup_UI SHALL display a voice-time remaining indicator in Space Mono at `--body` size, formatted as `VOICE: 1:42 LEFT` — this updates in real-time only while the user is actively speaking
10. THE floating widget expanded state SHALL show the remaining voice time as a Nothing-style segmented progress bar (12 segments representing 10 seconds each), with filled segments in `--text-display` depleting as voice time is consumed
11. WHEN 30 seconds of voice time remain, THE floating widget SHALL display `[0:30 VOICE LEFT]` in `--warning` color
12. WHEN 10 seconds of voice time remain, THE floating widget SHALL display `[0:10]` in `--accent` color with the accent red dot pulsing
13. WHEN voice time is exhausted, THE Extension SHALL gracefully stop the translation pipeline, restore the original microphone, and display `[DEMO LIMIT REACHED]` in the floating widget

##### Limit Reached — Next Steps UI
14. WHEN the 2-minute demo limit is reached, THE Extension SHALL display a full-width card in the Popup_UI with two clear options:
    - Option A: "Wait for reset" — showing a countdown timer to when the 24-hour window resets, formatted as `RESETS IN: 23:41:12` in Space Mono `--text-secondary`
    - Option B: "Use your own key" — a prominent button linking to the Settings page API key input, with text: "Enter your ElevenLabs API key for unlimited usage"
15. WHEN the demo limit is reached, THE floating widget SHALL display `[LIMIT — 23:41:12]` showing the countdown to reset, updating every minute
16. THE Extension SHALL NOT allow starting a new translation session while the demo limit is active and no BYO API key is configured — the toggle SHALL be disabled with a tooltip explaining why

##### 24-Hour Reset
17. THE Extension SHALL reset the voice-time counter to 0 exactly 24 hours after the first voice-time usage in the current window (rolling window, not calendar day)
18. WHEN the 24-hour reset occurs, THE Extension SHALL display `[DEMO RESET — 2:00 AVAILABLE]` in the floating widget and re-enable the translation toggle
19. THE Extension SHALL store the reset timestamp in `chrome.storage.local` and check it on extension startup to determine current quota status

##### BYO API Key — Unlimited Mode
20. WHEN the user enters their own ElevenLabs API key in the Settings page, THE Extension SHALL validate it via a test API call and, if valid, immediately switch to "Unlimited Mode" — removing all voice-time restrictions
21. WHILE in Unlimited Mode (BYO key), THE Popup_UI SHALL display `UNLIMITED` in Space Mono `--caption` `--success` color instead of the voice-time counter
22. THE Extension SHALL clearly distinguish between demo mode (using embedded/pre-configured key) and BYO mode (user's own key) in the Settings page with a visual indicator

##### Demo Limitation Information
23. THE Onboarding_Wizard (Step 1 - Welcome) SHALL clearly explain the demo limitations: "VoiceBridge Demo gives you 2 minutes of voice translation every 24 hours. Only your speaking time counts — silence and pauses are free. Enter your own API key for unlimited usage."
24. THE Settings page SHALL display a "Demo Mode" section explaining: what the limit is (2 min voice / 24 hours), why it exists ("to keep the free demo sustainable"), how to get unlimited ("enter your own ElevenLabs API key"), and where to get free credits

##### Credits Information and Claim Link
25. THE Onboarding_Wizard SHALL display a prominent card during API key setup (Step 2) with the text: "Get free ElevenLabs credits" linking to the ElevenLabs hackathon attendee offer page (https://hacks.elevenlabs.io/hackathons/4) — explaining that hackathon attendees can claim 1 month of ElevenLabs Creator plan (100,000 characters) for free
26. THE Settings page SHALL include a "Get Credits" section with: a link to claim the free ElevenLabs Creator plan from the hackathon, current plan status (Free/Starter/Creator), and a link to ElevenLabs pricing page for upgrading
27. THE "Get Credits" section SHALL also mention: "Already have an ElevenLabs account? Your API key works here — just paste it above."

##### Embedded Demo Key (Developer Configuration)
28. THE Extension SHALL support a pre-configured "demo API key" embedded in the extension build (via environment variable at build time) that is used when no BYO key is entered — this key is rate-limited by the 2-minute voice-time restriction
29. THE embedded demo key SHALL be stored obfuscated (not plaintext) in the extension bundle — while not truly secure (client-side), it prevents casual extraction
30. THE developer (you) SHALL be able to disable the embedded demo key entirely via a build flag, forcing all users to enter their own key
31. IF the embedded demo key's ElevenLabs quota is exhausted (API returns HTTP 402 or quota error), THE Extension SHALL immediately disable demo mode for ALL users, display a full-screen card in the Popup_UI: "Demo credits exhausted — enter your own ElevenLabs API key to continue" with the API key input field inline and a link to claim free hackathon credits
32. WHEN the embedded demo key is exhausted, THE Extension SHALL cache this state in `chrome.storage.local` and skip the quota check on subsequent startups (avoid repeated failed API calls) — checking again only once every 6 hours in case the developer tops up credits
33. WHEN the embedded demo key is exhausted, THE floating widget SHALL display `[NO DEMO CREDITS]` in `--text-disabled` and the translation toggle SHALL be disabled until a BYO key is entered

##### Cost Tracking
31. THE Extension SHALL track per-session usage: voice-time consumed, TTS characters generated, estimated cost in USD
32. THE Popup_UI footer SHALL display estimated session cost: `~$0.01` in `--caption` `--text-secondary`, calculated from actual characters sent to TTS × ElevenLabs per-character rate
