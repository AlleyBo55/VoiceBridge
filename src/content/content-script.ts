/**
 * Content script — injected into meeting pages.
 * Handles floating widget injection and WebRTC audio routing.
 * Does NOT modify page DOM until user explicitly enables translation.
 */

import { initMessageBus, sendMessage, onMessage, onPageMessage } from '../lib/message-bus.js';
import { detectPlatform } from '../lib/meeting-detector.js';

// ── State ───────────────────────────────────────────────────

let widgetInjected = false;

// ── Initialize ──────────────────────────────────────────────

function init(): void {
  initMessageBus();

  const platform = detectPlatform(window.location.href);
  if (platform === 'none') return;

  sendMessage('MEETING_DETECTED', { platform, tabId: 0 });

  // Listen for session events
  onMessage('SESSION_STATE_CHANGED', (state) => {
    if (state.active && !widgetInjected) {
      injectWidget();
    }
  });

  onMessage('TTS_AUDIO_CHUNK', () => {
    // Audio routing handled via virtual track
  });

  // Listen for page messages (main world script)
  onPageMessage('ORIGINAL_MIC_TRACK', (payload) => {
    const data = payload as { trackId: string };
    // Store reference to original mic track for restoration
    console.log('[VB] Original mic track stored:', data.trackId);
  });
}

// ── Widget Injection ────────────────────────────────────────

function injectWidget(): void {
  if (widgetInjected) return;

  // Create Shadow DOM host for style isolation
  const host = document.createElement('div');
  host.id = 'voicebridge-widget-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  // Widget HTML
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
    </style>
    <div class="vb-widget idle" role="button" tabindex="0"
         aria-label="VoiceBridge translation status: inactive">
      <div class="vb-collapsed">
        <svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
        <div class="vb-accent-dot"></div>
      </div>
    </div>
  `;

  document.body.appendChild(host);
  widgetInjected = true;

  // Click handler
  const widget = shadow.querySelector('.vb-widget') as HTMLElement;
  widget.addEventListener('click', () => {
    sendMessage('WIDGET_TOGGLE', undefined);
  });

  // Keyboard accessibility
  widget.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      sendMessage('WIDGET_TOGGLE', undefined);
    }
  });

  // Dragging
  makeDraggable(widget);

  // Idle fade timer
  let idleTimer: ReturnType<typeof setTimeout>;
  const resetIdle = () => {
    widget.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => widget.classList.add('idle'), 5000);
  };
  widget.addEventListener('mouseenter', resetIdle);
  resetIdle();
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

    // Save position per domain
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
