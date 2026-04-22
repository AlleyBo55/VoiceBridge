/**
 * Content script — injected into meeting pages.
 * Manages PlatformAdapter lifecycle, virtual audio track,
 * TTS audio reception, RTCPeerConnection monitoring, floating widget, and cleanup.
 */

import { initMessageBus, sendMessage, onMessage } from '../lib/message-bus.js';
import { detectPlatform } from '../lib/meeting-detector.js';
import { createPlatformAdapter } from '../lib/platform-adapters.js';
import type { PlatformAdapter } from '../lib/platform-adapters.js';
import type { MeetingPlatform, AudioRoutingState, DegradationLevel } from '../lib/types.js';

// ── Constants ───────────────────────────────────────────────

const OUTPUT_SAMPLE_RATE = 48000;

// ── State ───────────────────────────────────────────────────

let widgetInjected = false;
let adapter: PlatformAdapter | null = null;
let detectedPlatform: MeetingPlatform = 'none';
let widgetStatusEl: HTMLElement | null = null;
let widgetIconEl: SVGElement | null = null;

// Virtual track audio pipeline (content-script-local)
let virtualAudioCtx: AudioContext | null = null;
let virtualGainNode: GainNode | null = null;
let virtualDestination: MediaStreamAudioDestinationNode | null = null;

/** Whether the virtual track is currently injected into the meeting. */
function isTrackInjected(): boolean {
  return adapter?.isInjected() ?? false;
}

// ── Initialize ──────────────────────────────────────────────

function init(): void {
  initMessageBus();
  console.log('[VB:content] Content script initialized');

  detectedPlatform = detectPlatform(window.location.href);
  if (detectedPlatform === 'none') return;

  console.log('[VB:content] Meeting detected:', detectedPlatform);
  sendMessage('MEETING_DETECTED', { platform: detectedPlatform, tabId: 0 });

  setupMessageHandlers();
  setupBeforeUnload();
}

// ── Message Handlers ────────────────────────────────────────

function setupMessageHandlers(): void {
  // On session start, inject widget if not already done
  onMessage('SESSION_STATE_CHANGED', (state) => {
    if (state.active && !widgetInjected) {
      injectWidget();
    }
  });

  // On meeting detected (from service worker tab monitoring), initialize adapter
  onMessage('MEETING_DETECTED', async ({ platform }) => {
    if (adapter) return; // Already initialized
    await initializeAdapter(platform);
  });

  // SESSION_START: create virtual track and inject into meeting
  onMessage('SESSION_START', async () => {
    console.log('[VB:content] SESSION_START received — setting up virtual track');
    await setupVirtualTrack();
    await injectTrackIntoMeeting();
  });

  // SESSION_STOP: restore original track and tear down audio
  onMessage('SESSION_STOP', async () => {
    console.log('[VB:content] SESSION_STOP received — restoring original track');
    await teardownVirtualTrack();
  });

  // Receive TTS audio chunks from offscreen (via service worker relay)
  onMessage('TTS_AUDIO_TO_MEETING', ({ pcm, sequenceId }) => {
    console.log('[VB:content] TTS_AUDIO_TO_MEETING received', { samples: pcm.length, sequenceId });
    playPcmToVirtualTrack(pcm, sequenceId);
  });

  // Update widget based on audio routing state changes
  onMessage('AUDIO_ROUTING_STATE_CHANGED', ({ state }) => {
    updateWidgetIcon(state);
  });

  // Update widget based on degradation level changes
  onMessage('DEGRADATION_LEVEL_CHANGED', ({ level }) => {
    updateWidgetDegradation(level);
  });
}

// ── PlatformAdapter Lifecycle ───────────────────────────────

async function initializeAdapter(platform: MeetingPlatform): Promise<void> {
  adapter = createPlatformAdapter(platform);
  if (!adapter) return;

  try {
    await adapter.initialize();
  } catch (err) {
    sendMessage('ERROR', {
      code: 'injection-failed',
      message: err instanceof Error ? err.message : 'Platform adapter initialization failed',
      userMessage: 'Failed to inject audio into meeting.',
      action: 'retry',
    });
    updateWidgetStatus('[INJECTION FAILED]', 'error');
    adapter = null;
  }
}

// ── Virtual Track Audio Pipeline ─────────────────────────────

/**
 * Create a local AudioContext + MediaStreamDestination for the virtual track.
 * This runs entirely in the content script — no shared state with offscreen.
 */
async function setupVirtualTrack(): Promise<void> {
  if (virtualAudioCtx) {
    console.log('[VB:content] Virtual track already set up');
    return;
  }

  virtualAudioCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
  virtualGainNode = virtualAudioCtx.createGain();
  virtualDestination = virtualAudioCtx.createMediaStreamDestination();
  virtualGainNode.connect(virtualDestination);

  console.log('[VB:content] Virtual AudioContext created (48kHz)');
}

/**
 * Inject the virtual track into the meeting via the platform adapter.
 */
async function injectTrackIntoMeeting(): Promise<void> {
  if (!virtualDestination || !adapter) {
    console.warn('[VB:content] Cannot inject track — missing destination or adapter');
    sendMessage('TRACK_STATUS_UPDATE', { injected: false, platform: detectedPlatform });
    return;
  }

  const virtualTrack = virtualDestination.stream.getAudioTracks()[0];
  if (!virtualTrack) {
    console.error('[VB:content] No audio track on virtual destination');
    sendMessage('TRACK_STATUS_UPDATE', { injected: false, platform: detectedPlatform });
    return;
  }

  try {
    await adapter.injectVirtualTrack(virtualTrack);
    console.log('[VB:content] Virtual track injected into meeting successfully');
    sendMessage('TRACK_STATUS_UPDATE', { injected: true, platform: detectedPlatform });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[VB:content] Track injection failed:', message);
    sendMessage('TRACK_STATUS_UPDATE', { injected: false, platform: detectedPlatform });
    sendMessage('ERROR', {
      code: 'track-replace-failed',
      message,
      userMessage: 'Failed to inject audio into meeting.',
      action: 'retry',
    });
  }
}

/**
 * Receive PCM number[] from offscreen, convert to Float32, resample 24kHz→48kHz,
 * and play through the virtual track's AudioContext.
 */
function playPcmToVirtualTrack(pcmNumbers: number[], _sequenceId: number): void {
  if (!virtualAudioCtx || !virtualGainNode) {
    console.warn('[VB:content] No virtual AudioContext — dropping audio chunk');
    return;
  }

  // Convert number[] back to Int16Array
  const int16 = new Int16Array(pcmNumbers);

  // Convert Int16 → Float32 (divide by 32768)
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = (int16[i] ?? 0) / 32768.0;
  }

  // Resample 24kHz → 48kHz (2x via linear interpolation)
  const resampledLength = float32.length * 2;
  const resampled = new Float32Array(resampledLength);
  for (let i = 0; i < float32.length; i++) {
    const curr = float32[i] ?? 0;
    const next = float32[Math.min(i + 1, float32.length - 1)] ?? 0;
    resampled[i * 2] = curr;
    resampled[i * 2 + 1] = (curr + next) / 2;
  }

  // Create AudioBuffer at 48kHz and play
  const audioBuffer = virtualAudioCtx.createBuffer(1, resampledLength, OUTPUT_SAMPLE_RATE);
  audioBuffer.getChannelData(0).set(resampled);

  const source = virtualAudioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(virtualGainNode);
  source.start();
}

/**
 * Tear down the virtual track: restore original, close AudioContext.
 */
async function teardownVirtualTrack(): Promise<void> {
  if (adapter && isTrackInjected()) {
    try {
      await adapter.restoreOriginalTrack();
      console.log('[VB:content] Original track restored');
    } catch (err) {
      console.error('[VB:content] Failed to restore original track:', err);
    }
  }

  sendMessage('TRACK_STATUS_UPDATE', { injected: false, platform: detectedPlatform });

  if (virtualDestination) {
    for (const track of virtualDestination.stream.getTracks()) {
      track.stop();
    }
    virtualDestination = null;
  }

  virtualGainNode?.disconnect();
  virtualGainNode = null;

  if (virtualAudioCtx) {
    await virtualAudioCtx.close();
    virtualAudioCtx = null;
  }

  console.log('[VB:content] Virtual track torn down');
}

// ── beforeunload Handler ────────────────────────────────────

function setupBeforeUnload(): void {
  window.addEventListener('beforeunload', () => {
    console.log('[VB:content] Page unloading — cleaning up');
    sendMessage('SESSION_STOP', { reason: 'tab-closed' });

    if (adapter && isTrackInjected()) {
      // Best-effort restore — may not complete before unload
      void adapter.restoreOriginalTrack();
    }

    // Best-effort teardown of virtual audio
    if (virtualDestination) {
      for (const track of virtualDestination.stream.getTracks()) {
        track.stop();
      }
    }
    void virtualAudioCtx?.close();
  });
}

// ── Widget Injection ────────────────────────────────────────

function injectWidget(): void {
  if (widgetInjected) return;

  const host = document.createElement('div');
  host.id = 'voicebridge-widget-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .vb-widget {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483640;
        font-family: 'Space Grotesk', system-ui, sans-serif;
        transition: opacity 300ms cubic-bezier(0.25, 0.1, 0.25, 1);
        cursor: pointer;
        user-select: none;
      }
      .vb-widget.idle { opacity: 0.3; }
      .vb-widget:hover { opacity: 1; transition-duration: 150ms; }
      .vb-collapsed {
        width: 48px; height: 48px; border-radius: 50%;
        background: #111111; border: 1px solid #333333;
        display: flex; align-items: center; justify-content: center;
        position: relative;
      }
      .vb-collapsed svg {
        width: 24px; height: 24px; stroke: #E8E8E8;
        stroke-width: 1.5; fill: none;
        stroke-linecap: round; stroke-linejoin: round;
      }
      .vb-accent-dot {
        position: absolute; top: 4px; right: 4px;
        width: 6px; height: 6px; border-radius: 50%;
        background: #D71921; opacity: 0;
      }
      .vb-widget.recording .vb-accent-dot { opacity: 1; }
      .vb-status {
        position: absolute; bottom: -18px; left: 50%;
        transform: translateX(-50%); white-space: nowrap;
        font-family: 'Space Mono', monospace;
        font-size: 9px; letter-spacing: 0.08em;
        text-transform: uppercase; color: #999999;
      }
      .vb-status.warning { color: #D4A843; }
      .vb-status.error { color: #D71921; }
    </style>
    <div class="vb-widget idle" role="button" tabindex="0"
         aria-label="VoiceBridge translation status: inactive">
      <div class="vb-collapsed">
        <svg class="vb-icon" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
        <div class="vb-accent-dot"></div>
      </div>
      <div class="vb-status"></div>
    </div>
  `;

  document.body.appendChild(host);
  widgetInjected = true;

  const widget = shadow.querySelector('.vb-widget') as HTMLElement;
  widgetStatusEl = shadow.querySelector('.vb-status') as HTMLElement;
  widgetIconEl = shadow.querySelector('.vb-icon') as SVGElement;

  widget.addEventListener('click', () => {
    sendMessage('WIDGET_TOGGLE', undefined);
  });

  widget.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      sendMessage('WIDGET_TOGGLE', undefined);
    }
  });

  makeDraggable(widget);

  let idleTimer: ReturnType<typeof setTimeout>;
  const resetIdle = (): void => {
    widget.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => widget.classList.add('idle'), 5000);
  };
  widget.addEventListener('mouseenter', resetIdle);
  resetIdle();
}

// ── Widget Updates ──────────────────────────────────────────

function updateWidgetIcon(routingState: AudioRoutingState): void {
  if (!widgetIconEl) return;

  const icons: Record<AudioRoutingState, string> = {
    PASSTHROUGH: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
    MUTED: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17"/><line x1="12" y1="19" x2="12" y2="22"/>',
    TTS_PLAYING: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    BARGE_IN: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><circle cx="12" cy="12" r="10" stroke-dasharray="4 4"/>',
  };

  widgetIconEl.innerHTML = icons[routingState] ?? icons.PASSTHROUGH;
}

function updateWidgetDegradation(level: DegradationLevel): void {
  if (!widgetStatusEl) return;

  switch (level) {
    case 'full':
      widgetStatusEl.textContent = '';
      widgetStatusEl.className = 'vb-status';
      break;
    case 'text-only':
      widgetStatusEl.textContent = '[TEXT ONLY]';
      widgetStatusEl.className = 'vb-status warning';
      break;
    case 'transcription-only':
      widgetStatusEl.textContent = '[TRANSCRIPT ONLY]';
      widgetStatusEl.className = 'vb-status warning';
      break;
    case 'passthrough':
      widgetStatusEl.textContent = '[PASSTHROUGH]';
      widgetStatusEl.className = 'vb-status error';
      break;
  }
}

function updateWidgetStatus(text: string, type: 'warning' | 'error' | '' = ''): void {
  if (!widgetStatusEl) return;
  widgetStatusEl.textContent = text;
  widgetStatusEl.className = `vb-status${type ? ` ${type}` : ''}`;
}

// ── Dragging ────────────────────────────────────────────────

function makeDraggable(el: HTMLElement): void {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let origX = 0;
  let origY = 0;

  el.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;
    el.style.transition = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.style.position = 'fixed';
    el.style.left = `${origX + dx}px`;
    el.style.top = `${origY + dy}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    el.style.transition = '';

    const rect = el.getBoundingClientRect();
    sendMessage('WIDGET_POSITION_SAVE', {
      domain: window.location.hostname,
      x: rect.left,
      y: rect.top,
    });
  });
}

// ── Boot ────────────────────────────────────────────────────

init();
