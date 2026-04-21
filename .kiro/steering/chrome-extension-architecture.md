# Chrome Extension Architecture — Manifest V3 Standards

This project is a Chrome Extension built on Manifest V3. Follow these architectural rules at all times.

## Extension Structure

```
src/
├── manifest.json              # Manifest V3 config
├── background/
│   └── service-worker.ts      # Background service worker (orchestrator)
├── offscreen/
│   ├── offscreen.html         # Offscreen document for persistent connections
│   └── offscreen.ts           # WebSocket management, audio processing
├── content/
│   ├── content-script.ts      # Injected into meeting pages
│   └── widget.ts              # Floating widget injection
├── popup/
│   ├── popup.html
│   └── popup.ts               # Extension popup UI
├── sidepanel/
│   ├── sidepanel.html
│   └── sidepanel.ts           # Live transcript panel
├── options/
│   ├── options.html
│   └── options.ts             # Settings page
├── onboarding/
│   ├── onboarding.html
│   └── onboarding.ts          # First-time setup wizard
├── lib/
│   ├── stt-client.ts          # ElevenLabs Scribe WebSocket client
│   ├── tts-client.ts          # ElevenLabs TTS WebSocket client
│   ├── translation-engine.ts  # LLM translation layer
│   ├── audio-capture.ts       # Mic capture + AudioWorklet
│   ├── audio-output.ts        # Virtual mic + meeting injection
│   ├── echo-cancellation.ts   # Feedback prevention state machine
│   ├── meeting-detector.ts    # Platform detection
│   ├── voice-profile.ts       # Voice cloning management
│   ├── settings-store.ts      # chrome.storage wrapper
│   ├── latency-monitor.ts     # Pipeline latency tracking
│   └── message-bus.ts         # Inter-context messaging
├── worklets/
│   └── audio-processor.worklet.ts  # AudioWorklet for PCM conversion
└── styles/
    ├── tokens.css             # Nothing design system CSS variables
    ├── widget.css             # Floating widget styles
    └── shared.css             # Shared component styles
```

## Manifest V3 Rules

- Use `"manifest_version": 3`
- Background MUST be a service worker (not a persistent background page)
- Service workers are ephemeral — they can be terminated at any time by Chrome
- Use offscreen documents for persistent WebSocket connections
- Content scripts run in isolated worlds — communicate via `chrome.runtime.sendMessage`
- Use `chrome.storage.local` for persistent data, `chrome.storage.session` for session data
- Declare all permissions explicitly — no wildcards unless necessary

## Service Worker Lifecycle

The service worker WILL be terminated by Chrome after ~30 seconds of inactivity. Design for this:

1. Never store state only in service worker memory
2. Use offscreen document for WebSocket connections that must persist
3. On wake-up, re-attach to existing offscreen document connections
4. Use `chrome.alarms` for periodic tasks, not `setInterval`
5. Persist critical state in `chrome.storage.session`

## Inter-Context Communication

```
Service Worker ←→ Offscreen Document (chrome.runtime.sendMessage)
Service Worker ←→ Content Script (chrome.tabs.sendMessage / chrome.runtime.sendMessage)
Service Worker ←→ Popup (chrome.runtime.sendMessage)
Service Worker ←→ Side Panel (chrome.runtime.sendMessage)
Content Script ←→ Page (window.postMessage with origin check)
```

Message format:
```typescript
interface ExtensionMessage {
  type: string;        // e.g., "STT_TRANSCRIPT", "TTS_AUDIO", "TOGGLE_SESSION"
  payload: unknown;
  timestamp: number;
  sequenceId?: number;
}
```

## Offscreen Document

- Created via `chrome.offscreen.createDocument()` with reason `"AUDIO_PLAYBACK"` or `"WEB_RTC"`
- Maintains WebSocket connections to ElevenLabs STT and TTS
- Handles audio processing that requires persistent context
- Only ONE offscreen document can exist at a time per extension
- Check if it exists before creating: `chrome.offscreen.hasDocument()`

## Content Script Injection

- Inject only on meeting platform URLs (declared in manifest)
- Do NOT modify page DOM until user explicitly enables translation
- Use Shadow DOM for the floating widget to isolate styles from the host page
- Never access page JavaScript directly — use `window.postMessage` bridge if needed
- For WebRTC interception, inject a script element into the page's main world

## Audio in Extensions

- `getUserMedia` works in offscreen documents and content scripts
- `AudioWorklet` requires a secure context (HTTPS page or extension page)
- Use `chrome.tabCapture` for capturing tab audio (requires `tabCapture` permission)
- Audio processing should happen in the offscreen document to avoid service worker termination

## Storage Strategy

| Data | Storage | Why |
|------|---------|-----|
| API keys (encrypted) | `chrome.storage.local` | Persists across sessions, device-local |
| Voice profile ID | `chrome.storage.local` | Persists, needed for TTS |
| User preferences | `chrome.storage.sync` | Syncs across devices |
| Session state | `chrome.storage.session` | Cleared on browser close |
| Transcript history | In-memory (offscreen) | Never persisted for privacy |
| Widget position | `chrome.storage.local` | Per-domain preference |

## Security

- Never expose API keys in content scripts (they run in web page context)
- API calls happen ONLY from service worker or offscreen document
- Use Web Crypto API for encrypting stored API keys
- Validate all messages between contexts (check `sender.id` matches extension ID)
- Content Security Policy: `script-src 'self'; object-src 'none'`
