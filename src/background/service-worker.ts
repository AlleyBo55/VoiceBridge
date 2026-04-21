/**
 * Background service worker — session orchestrator.
 * Ephemeral by design (~30s idle timeout). Manages offscreen document lifecycle,
 * meeting detection, keyboard commands, session state persistence,
 * MessageChannel brokering, and demo bootstrap.
 */

import { initMessageBus, sendMessage, onMessage } from '../lib/message-bus.js';
import { getSetting, setSetting, initializeInstall } from '../lib/settings-store.js';
import { detectPlatform } from '../lib/meeting-detector.js';
import { bootstrapDemoKeys } from '../lib/demo-bootstrap.js';
import { log } from '../lib/debug-log.js';

// ── Offscreen Document Management ───────────────────────────

let offscreenCreated = false;

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'WebSocket connections and audio processing for real-time translation',
  });

  offscreenCreated = true;
  log('info', 'state', 'Offscreen document created');
}

// ── MessageChannel Broker ───────────────────────────────────

let activeChannel: MessageChannel | null = null;

/**
 * Create a MessageChannel port pair and distribute ports
 * to the offscreen document and content script.
 */
async function setupMessageChannel(tabId: number): Promise<void> {
  // Close existing channel if any
  closeMessageChannel();

  activeChannel = new MessageChannel();

  // Send port1 to offscreen document
  // The offscreen document listens via navigator.serviceWorker message events
  const offscreenContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (offscreenContexts.length > 0) {
    // Post port1 to offscreen via chrome.runtime.sendMessage
    // Note: In MV3, MessagePort transfer between contexts uses
    // chrome.runtime.sendMessage with the port in the message
    chrome.runtime.sendMessage({
      type: 'AUDIO_BRIDGE_PORT',
      target: 'offscreen',
    });
  }

  // Send port2 to content script
  chrome.tabs.sendMessage(tabId, {
    type: 'AUDIO_BRIDGE_PORT',
    target: 'content-script',
  });

  log('info', 'state', `MessageChannel established for tab ${tabId}`);
}

/** Close both MessageChannel ports and release resources. */
function closeMessageChannel(): void {
  if (activeChannel) {
    try { activeChannel.port1.close(); } catch { /* already closed */ }
    try { activeChannel.port2.close(); } catch { /* already closed */ }
    activeChannel = null;
  }
}

// ── Initialize ──────────────────────────────────────────────

async function init(): Promise<void> {
  initMessageBus();
  await initializeInstall();

  log('info', 'state', 'Service worker initialized');

  const onboarded = await getSetting('onboardingComplete');
  if (!onboarded) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#D71921' });
  }

  setupMessageHandlers();
  setupTabMonitoring();
  setupCommands();
  setupUpdateHandler();
}

// ── Message Handlers ────────────────────────────────────────

function setupMessageHandlers(): void {
  onMessage('SESSION_START', async (payload) => {
    await ensureOffscreenDocument();

    // Set up MessageChannel for audio bridge
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) {
      await setupMessageChannel(tabId);
    }

    // Forward to offscreen document
    sendMessage('SESSION_START', payload);

    await chrome.storage.session.set({
      sessionActive: true,
      sessionStartedAt: Date.now(),
      sourceLanguage: payload.sourceLanguage,
      targetLanguage: payload.targetLanguage,
    });
  });

  onMessage('SESSION_STOP', async (payload) => {
    sendMessage('SESSION_STOP', payload);

    // Close MessageChannel ports
    closeMessageChannel();

    await chrome.storage.session.set({ sessionActive: false });
  });

  onMessage('MEETING_DETECTED', ({ platform, tabId }) => {
    log('info', 'state', `Meeting detected: ${platform} on tab ${tabId}`);
  });

  onMessage('WIDGET_TOGGLE', () => {
    sendMessage('SESSION_START', { sourceLanguage: 'auto', targetLanguage: 'es' });
  });
}

// ── Tab URL Monitoring ──────────────────────────────────────

function setupTabMonitoring(): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.url) {
      const platform = detectPlatform(tab.url);
      if (platform !== 'none') {
        sendMessage('MEETING_DETECTED', { platform, tabId });
      }
    }
  });
}

// ── Keyboard Commands ───────────────────────────────────────

function setupCommands(): void {
  chrome.commands.onCommand.addListener(async (command) => {
    switch (command) {
      case 'toggle-translation': {
        const session = await chrome.storage.session.get('sessionActive');
        if (session['sessionActive']) {
          sendMessage('SESSION_STOP', { reason: 'user' });
        } else {
          const source = await getSetting('sourceLanguage');
          const target = await getSetting('targetLanguage');
          await ensureOffscreenDocument();
          sendMessage('SESSION_START', { sourceLanguage: source, targetLanguage: target });
        }
        break;
      }

      case 'panic-stop':
        sendMessage('SESSION_STOP', { reason: 'user' });
        log('info', 'state', 'Panic stop triggered');
        break;

      case 'toggle-ghost-mode': {
        const ghostMode = await getSetting('ghostMode');
        await setSetting('ghostMode', !ghostMode);
        sendMessage('GHOST_MODE_TOGGLE', { enabled: !ghostMode });
        break;
      }

      case 'language-roulette':
        sendMessage('ROULETTE_START', { sentence: '', languages: [] });
        break;
    }
  });
}

// ── Extension Update Handling ───────────────────────────────

function setupUpdateHandler(): void {
  chrome.runtime.onUpdateAvailable.addListener(async () => {
    const session = await chrome.storage.session.get('sessionActive');
    if (session['sessionActive']) {
      log('info', 'state', 'Update available but session active — deferring');
      onMessage('SESSION_STOP', () => {
        chrome.runtime.reload();
      });
    } else {
      chrome.runtime.reload();
    }
  });
}

// ── First Install + Demo Bootstrap ──────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Bootstrap demo keys on first install
    const populated = await bootstrapDemoKeys();
    if (populated) {
      log('info', 'state', 'Demo keys populated on first install');
      sendMessage('DEMO_KEYS_POPULATED', { provider: 'openrouter' });
    }

    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
});

// ── Boot ────────────────────────────────────────────────────

init();
