# VoiceBridge — Platform Adapter Technical Reference

> How audio injection works on each meeting platform. The WebRTC layer is where the magic happens — and where every platform does things differently.

## The Problem

Meeting platforms use WebRTC for audio/video. The user's microphone feeds into an `RTCPeerConnection` via a `MediaStreamTrack`. To make other participants hear translated audio instead of the original voice, we need to replace that track with our virtual audio source.

Every platform implements WebRTC slightly differently. Some let you swap tracks freely. Some intercept `getUserMedia`. Some use custom media stacks that resist modification.

## The Solution: Platform Adapters

Each adapter implements the same interface:

```typescript
interface PlatformAdapter {
  readonly platform: MeetingPlatform;
  initialize(): Promise<void>;
  injectVirtualTrack(track: MediaStreamTrack): Promise<void>;
  restoreOriginalTrack(): Promise<void>;
  isInjected(): boolean;
  destroy(): void;
}
```

The `MeetingDetector` identifies the platform from the URL. The content script instantiates the correct adapter.

---

## Google Meet

**Strategy**: `getUserMedia` intercept

Google Meet calls `navigator.mediaDevices.getUserMedia()` to get the user's microphone. We intercept this call before the page loads.

### How It Works

1. A main-world script is injected at `document_start` (before Meet's JavaScript runs)
2. The script wraps `navigator.mediaDevices.getUserMedia`:
   ```javascript
   const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia = async (constraints) => {
     const stream = await original(constraints);
     // Store reference to original audio track
     // Replace later when session starts
     return stream;
   };
   ```
3. When translation starts, we locate the `RTCPeerConnection` audio sender and call `replaceTrack()` with our virtual track
4. When translation stops, we restore the original track

### Quirks

- Meet may create multiple `RTCPeerConnection` instances (one per participant in some configurations)
- Meet's code is minified and changes frequently — we rely on standard WebRTC APIs, not DOM selectors
- The `getUserMedia` intercept must happen before any of Meet's scripts execute

---

## Microsoft Teams

**Strategy**: `RTCPeerConnection` constructor monitoring + `replaceTrack`

### How It Works

1. A main-world script monitors the `RTCPeerConnection` constructor:
   ```javascript
   const Original = window.RTCPeerConnection;
   window.RTCPeerConnection = function(...args) {
     const pc = new Original(...args);
     // Track this connection
     window.postMessage({ source: 'voicebridge', type: 'RTC_PC_CREATED' }, '*');
     return pc;
   };
   ```
2. When translation starts, we find the audio sender on the captured peer connection:
   ```javascript
   const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
   await sender.replaceTrack(virtualTrack);
   ```
3. When translation stops, we restore the original track

### Quirks

- Teams may renegotiate the peer connection during a call (participant joins/leaves)
- We monitor `connectionstatechange` and `track` events to detect renegotiation and re-apply the virtual track

---

## Discord

**Strategy**: Same as Teams — `RTCPeerConnection` monitoring + `replaceTrack`

Discord uses standard WebRTC. The same approach as Teams works.

### Quirks

- Discord creates peer connections per voice channel, not per participant
- The peer connection is created when joining a voice channel, not when the page loads

---

## Zoom Web

**Strategy**: `tabCapture` fallback

Zoom's web client uses a custom media stack that restricts direct `replaceTrack()` on their peer connections.

### How It Works

1. Use `chrome.tabCapture.capture()` to get the tab's audio output stream
2. Create an `AudioContext` with a mixing node
3. Mix our TTS audio into the tab's audio output
4. The mixed audio reaches Zoom's media stack through the tab's audio context

### Quirks

- `tabCapture` requires the `tabCapture` permission in the manifest
- The mixed audio includes both the TTS output and any other tab audio (meeting sounds, etc.)
- Audio quality may be slightly lower than direct `replaceTrack` due to the mixing step
- This is a fallback strategy — less clean than direct track replacement but works with Zoom's restrictions

---

## Generic WebRTC (Force Enable)

**Strategy**: Same as Teams — `RTCPeerConnection` monitoring + `replaceTrack`

For any WebRTC-based meeting app not in the known list. The user triggers this manually via "Force Enable" in the popup.

### How It Works

Same as Teams/Discord — monitor `RTCPeerConnection` constructor, capture connections, `replaceTrack()` on audio sender.

### Quirks

- May not work with apps that use non-standard WebRTC implementations
- The user accepts the risk when clicking "Force Enable"

---

## Track Lifecycle

Regardless of platform, the track lifecycle follows this pattern:

```
1. Session starts
   → Store reference to original mic track
   → Create virtual track (MediaStreamDestination)
   → Replace original track with virtual track via adapter

2. During translation
   → Virtual track carries silence (MUTED state)
   → Virtual track carries TTS audio (TTS_PLAYING state)
   → Virtual track carries original mic (BARGE_IN state)

3. Session ends
   → Restore original mic track via adapter
   → Destroy virtual track
   → Clean up adapter
```

The virtual track is always active — it just switches what audio it carries based on the routing state machine. This prevents any gaps in the audio stream that WebRTC might interpret as a disconnection.

---

## Communication Protocol

Content script ↔ main-world script communication uses `window.postMessage`:

```javascript
// Content script → main world
window.postMessage({
  source: 'voicebridge',
  type: 'INJECT_TRACK',
  payload: { /* track info */ }
}, window.location.origin);

// Main world → content script
window.postMessage({
  source: 'voicebridge',
  type: 'TRACK_INJECTED',
  payload: { success: true }
}, window.location.origin);
```

Every message is validated:
- `event.origin` must match `window.location.origin`
- `event.data.source` must be `'voicebridge'`
- Messages from unknown sources are silently ignored
