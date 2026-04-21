/**
 * Platform-specific audio injection adapters.
 * Each adapter knows how to inject a virtual audio track into
 * the meeting platform's WebRTC peer connection.
 *
 * These adapters run in the content script context and use
 * postToPage/onPageMessage for main-world script communication.
 */

import type { MeetingPlatform } from './types.js';
import { postToPage, onPageMessage } from './message-bus.js';

// ── PlatformAdapter Interface ───────────────────────────────

/**
 * Platform-specific audio injection adapter.
 * Each adapter knows how to inject a virtual audio track into
 * the meeting platform's WebRTC peer connection.
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: MeetingPlatform;

  /** Initialize the adapter — inject main-world scripts, set up monitors */
  initialize(): Promise<void>;

  /** Replace the meeting's mic track with the virtual track */
  injectVirtualTrack(track: MediaStreamTrack): Promise<void>;

  /** Restore the original microphone track */
  restoreOriginalTrack(): Promise<void>;

  /** Check if the virtual track is currently injected */
  isInjected(): boolean;

  /** Clean up all injected scripts, listeners, and references */
  destroy(): void;
}

// ── Google Meet Adapter ─────────────────────────────────────

/**
 * Intercepts navigator.mediaDevices.getUserMedia at document_start.
 * Stores original audio track, replaces via replaceTrack on session start.
 *
 * Injection strategy: main-world script via <script> element that
 * wraps getUserMedia before the page loads.
 */
export class GoogleMeetAdapter implements PlatformAdapter {
  readonly platform = 'google-meet' as const;
  #originalTrack: MediaStreamTrack | null = null;
  #injected = false;
  #cleanupListeners: Array<() => void> = [];

  /**
   * Inject a main-world script that intercepts getUserMedia
   * and stores the original audio track reference.
   */
  async initialize(): Promise<void> {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async function(constraints) {
          const stream = await origGetUserMedia(constraints);
          const audioTrack = stream.getAudioTracks()[0];
          if (audioTrack) {
            window.postMessage({
              source: 'voicebridge',
              type: 'original-track-captured',
              payload: { trackId: audioTrack.id }
            }, window.location.origin);
          }
          return stream;
        };
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    const removeListener = onPageMessage('original-track-captured', (_payload) => {
      // Track ID received — the main-world script captured the original track.
      // Actual track reference is managed via replaceTrack on the RTCPeerConnection.
    });
    this.#cleanupListeners.push(removeListener);
  }

  /**
   * Replace the meeting's audio track with the virtual TTS track.
   * Communicates with the main-world script to perform replaceTrack.
   */
  async injectVirtualTrack(track: MediaStreamTrack): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('GoogleMeetAdapter: injectVirtualTrack timed out'));
      }, 5000);

      const removeListener = onPageMessage('track-injected', (payload) => {
        clearTimeout(timeout);
        removeListener();
        const result = payload as { success: boolean; error?: string };
        if (result.success) {
          this.#injected = true;
          resolve();
        } else {
          reject(new Error(result.error ?? 'GoogleMeetAdapter: injection failed'));
        }
      });
      this.#cleanupListeners.push(removeListener);

      // Store original track reference before injection
      this.#originalTrack = track;
      postToPage('inject-virtual-track', { trackId: track.id });
    });
  }

  /**
   * Restore the original microphone track on the RTCPeerConnection.
   */
  async restoreOriginalTrack(): Promise<void> {
    if (!this.#injected || !this.#originalTrack) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#injected = false;
        resolve();
      }, 2000);

      const removeListener = onPageMessage('track-restored', () => {
        clearTimeout(timeout);
        removeListener();
        this.#injected = false;
        resolve();
      });
      this.#cleanupListeners.push(removeListener);

      postToPage('restore-original-track', { trackId: this.#originalTrack?.id });
    });
  }

  /** Check if the virtual track is currently injected. */
  isInjected(): boolean {
    return this.#injected;
  }

  /** Clean up all injected scripts, listeners, and references. */
  destroy(): void {
    for (const cleanup of this.#cleanupListeners) {
      cleanup();
    }
    this.#cleanupListeners = [];
    this.#originalTrack = null;
    this.#injected = false;
  }
}

// ── Teams Adapter ───────────────────────────────────────────

/**
 * Monitors RTCPeerConnection constructor in main world.
 * Captures peer connections, uses replaceTrack() on audio sender.
 */
export class TeamsAdapter implements PlatformAdapter {
  readonly platform = 'teams' as const;
  #originalTrack: MediaStreamTrack | null = null;
  #injected = false;
  #cleanupListeners: Array<() => void> = [];

  /**
   * Inject a main-world script that monitors the RTCPeerConnection
   * constructor and captures created peer connections.
   */
  async initialize(): Promise<void> {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const OrigRTCPeerConnection = window.RTCPeerConnection;
        const connections = new Set();

        window.RTCPeerConnection = function(...args) {
          const pc = new OrigRTCPeerConnection(...args);
          connections.add(pc);
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'closed') connections.delete(pc);
          });
          window.postMessage({
            source: 'voicebridge',
            type: 'peer-connection-created',
            payload: { count: connections.size }
          }, window.location.origin);
          return pc;
        };
        window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;

        window.addEventListener('message', (event) => {
          if (event.origin !== window.location.origin) return;
          const data = event.data;
          if (data?.source !== 'voicebridge') return;

          if (data.type === 'inject-virtual-track') {
            let replaced = false;
            for (const pc of connections) {
              const senders = pc.getSenders();
              for (const sender of senders) {
                if (sender.track?.kind === 'audio') {
                  window.__voicebridgeOriginalTrack = sender.track;
                  // replaceTrack is async but we handle via postMessage
                  sender.replaceTrack(null).then(() => {
                    replaced = true;
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-injected',
                      payload: { success: true }
                    }, window.location.origin);
                  }).catch((err) => {
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-injected',
                      payload: { success: false, error: err.message }
                    }, window.location.origin);
                  });
                  break;
                }
              }
              if (replaced) break;
            }
            if (!replaced && connections.size === 0) {
              window.postMessage({
                source: 'voicebridge',
                type: 'track-injected',
                payload: { success: false, error: 'No peer connections found' }
              }, window.location.origin);
            }
          }

          if (data.type === 'restore-original-track') {
            const origTrack = window.__voicebridgeOriginalTrack;
            let restored = false;
            for (const pc of connections) {
              const senders = pc.getSenders();
              for (const sender of senders) {
                if (sender.track === null || sender.track?.kind === 'audio') {
                  sender.replaceTrack(origTrack || null).then(() => {
                    restored = true;
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-restored',
                      payload: { success: true }
                    }, window.location.origin);
                  }).catch(() => {
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-restored',
                      payload: { success: true }
                    }, window.location.origin);
                  });
                  break;
                }
              }
              if (restored) break;
            }
            if (!restored) {
              window.postMessage({
                source: 'voicebridge',
                type: 'track-restored',
                payload: { success: true }
              }, window.location.origin);
            }
          }
        });
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    const removeListener = onPageMessage('peer-connection-created', (_payload) => {
      // Peer connection detected — ready for track injection.
    });
    this.#cleanupListeners.push(removeListener);
  }

  /**
   * Replace the audio sender track on captured RTCPeerConnections.
   */
  async injectVirtualTrack(track: MediaStreamTrack): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TeamsAdapter: injectVirtualTrack timed out'));
      }, 5000);

      const removeListener = onPageMessage('track-injected', (payload) => {
        clearTimeout(timeout);
        removeListener();
        const result = payload as { success: boolean; error?: string };
        if (result.success) {
          this.#originalTrack = track;
          this.#injected = true;
          resolve();
        } else {
          reject(new Error(result.error ?? 'TeamsAdapter: injection failed'));
        }
      });
      this.#cleanupListeners.push(removeListener);

      postToPage('inject-virtual-track', { trackId: track.id });
    });
  }

  /**
   * Restore the original microphone track on the RTCPeerConnection.
   */
  async restoreOriginalTrack(): Promise<void> {
    if (!this.#injected || !this.#originalTrack) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#injected = false;
        resolve();
      }, 2000);

      const removeListener = onPageMessage('track-restored', () => {
        clearTimeout(timeout);
        removeListener();
        this.#injected = false;
        resolve();
      });
      this.#cleanupListeners.push(removeListener);

      postToPage('restore-original-track', { trackId: this.#originalTrack?.id });
    });
  }

  /** Check if the virtual track is currently injected. */
  isInjected(): boolean {
    return this.#injected;
  }

  /** Clean up all injected scripts, listeners, and references. */
  destroy(): void {
    for (const cleanup of this.#cleanupListeners) {
      cleanup();
    }
    this.#cleanupListeners = [];
    this.#originalTrack = null;
    this.#injected = false;
  }
}

// ── Discord Adapter ─────────────────────────────────────────

/**
 * Same strategy as Teams — monitor RTCPeerConnection constructor,
 * capture connections, replaceTrack() on audio sender.
 */
export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord' as const;
  #originalTrack: MediaStreamTrack | null = null;
  #injected = false;
  #cleanupListeners: Array<() => void> = [];

  /**
   * Inject a main-world script that monitors the RTCPeerConnection
   * constructor and captures created peer connections.
   */
  async initialize(): Promise<void> {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const OrigRTCPeerConnection = window.RTCPeerConnection;
        const connections = new Set();

        window.RTCPeerConnection = function(...args) {
          const pc = new OrigRTCPeerConnection(...args);
          connections.add(pc);
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'closed') connections.delete(pc);
          });
          window.postMessage({
            source: 'voicebridge',
            type: 'peer-connection-created',
            payload: { count: connections.size }
          }, window.location.origin);
          return pc;
        };
        window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;

        window.addEventListener('message', (event) => {
          if (event.origin !== window.location.origin) return;
          const data = event.data;
          if (data?.source !== 'voicebridge') return;

          if (data.type === 'inject-virtual-track') {
            let replaced = false;
            for (const pc of connections) {
              const senders = pc.getSenders();
              for (const sender of senders) {
                if (sender.track?.kind === 'audio') {
                  window.__voicebridgeOriginalTrack = sender.track;
                  sender.replaceTrack(null).then(() => {
                    replaced = true;
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-injected',
                      payload: { success: true }
                    }, window.location.origin);
                  }).catch((err) => {
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-injected',
                      payload: { success: false, error: err.message }
                    }, window.location.origin);
                  });
                  break;
                }
              }
              if (replaced) break;
            }
            if (!replaced && connections.size === 0) {
              window.postMessage({
                source: 'voicebridge',
                type: 'track-injected',
                payload: { success: false, error: 'No peer connections found' }
              }, window.location.origin);
            }
          }

          if (data.type === 'restore-original-track') {
            const origTrack = window.__voicebridgeOriginalTrack;
            let restored = false;
            for (const pc of connections) {
              const senders = pc.getSenders();
              for (const sender of senders) {
                if (sender.track === null || sender.track?.kind === 'audio') {
                  sender.replaceTrack(origTrack || null).then(() => {
                    restored = true;
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-restored',
                      payload: { success: true }
                    }, window.location.origin);
                  }).catch(() => {
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-restored',
                      payload: { success: true }
                    }, window.location.origin);
                  });
                  break;
                }
              }
              if (restored) break;
            }
            if (!restored) {
              window.postMessage({
                source: 'voicebridge',
                type: 'track-restored',
                payload: { success: true }
              }, window.location.origin);
            }
          }
        });
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    const removeListener = onPageMessage('peer-connection-created', (_payload) => {
      // Peer connection detected — ready for track injection.
    });
    this.#cleanupListeners.push(removeListener);
  }

  /**
   * Replace the audio sender track on captured RTCPeerConnections.
   */
  async injectVirtualTrack(track: MediaStreamTrack): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('DiscordAdapter: injectVirtualTrack timed out'));
      }, 5000);

      const removeListener = onPageMessage('track-injected', (payload) => {
        clearTimeout(timeout);
        removeListener();
        const result = payload as { success: boolean; error?: string };
        if (result.success) {
          this.#originalTrack = track;
          this.#injected = true;
          resolve();
        } else {
          reject(new Error(result.error ?? 'DiscordAdapter: injection failed'));
        }
      });
      this.#cleanupListeners.push(removeListener);

      postToPage('inject-virtual-track', { trackId: track.id });
    });
  }

  /**
   * Restore the original microphone track on the RTCPeerConnection.
   */
  async restoreOriginalTrack(): Promise<void> {
    if (!this.#injected || !this.#originalTrack) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#injected = false;
        resolve();
      }, 2000);

      const removeListener = onPageMessage('track-restored', () => {
        clearTimeout(timeout);
        removeListener();
        this.#injected = false;
        resolve();
      });
      this.#cleanupListeners.push(removeListener);

      postToPage('restore-original-track', { trackId: this.#originalTrack?.id });
    });
  }

  /** Check if the virtual track is currently injected. */
  isInjected(): boolean {
    return this.#injected;
  }

  /** Clean up all injected scripts, listeners, and references. */
  destroy(): void {
    for (const cleanup of this.#cleanupListeners) {
      cleanup();
    }
    this.#cleanupListeners = [];
    this.#originalTrack = null;
    this.#injected = false;
  }
}

// ── Zoom Adapter ────────────────────────────────────────────

/**
 * Zoom Web uses a custom media stack. Falls back to tabCapture mixing.
 * Uses chrome.tabCapture.capture() to get tab audio, creates an
 * AudioContext mixing node that combines TTS with tab output.
 */
export class ZoomAdapter implements PlatformAdapter {
  readonly platform = 'zoom' as const;
  #originalTrack: MediaStreamTrack | null = null;
  #injected = false;
  #tabCaptureStream: MediaStream | null = null;
  #mixingContext: AudioContext | null = null;
  #mixingDestination: MediaStreamAudioDestinationNode | null = null;

  /**
   * Initialize the Zoom adapter. No main-world script injection needed —
   * Zoom uses tabCapture mixing instead of RTCPeerConnection interception.
   */
  async initialize(): Promise<void> {
    // Zoom adapter uses tabCapture approach, no main-world script needed.
    // Initialization is deferred to injectVirtualTrack when the session starts.
  }

  /**
   * Set up tabCapture mixing: capture tab audio, create a mixing node
   * that combines TTS audio with the tab output.
   */
  async injectVirtualTrack(track: MediaStreamTrack): Promise<void> {
    this.#originalTrack = track;

    // Create mixing AudioContext at 48kHz for WebRTC compatibility
    this.#mixingContext = new AudioContext({ sampleRate: 48000 });
    this.#mixingDestination = this.#mixingContext.createMediaStreamDestination();

    // Connect the virtual TTS track as a source into the mixing node
    const ttsStream = new MediaStream([track]);
    const ttsSource = this.#mixingContext.createMediaStreamSource(ttsStream);
    ttsSource.connect(this.#mixingDestination);

    // If tabCapture is available, mix tab audio as well
    if (chrome.tabCapture) {
      try {
        const tabStream = await new Promise<MediaStream>((resolve, reject) => {
          chrome.tabCapture.capture(
            { audio: true, video: false },
            (stream) => {
              if (stream) {
                resolve(stream);
              } else {
                reject(new Error('tabCapture returned null'));
              }
            }
          );
        });
        this.#tabCaptureStream = tabStream;
        const tabSource = this.#mixingContext.createMediaStreamSource(tabStream);
        tabSource.connect(this.#mixingDestination);
      } catch {
        // tabCapture may not be available — continue with TTS-only mixing
      }
    }

    this.#injected = true;
  }

  /**
   * Restore original state by tearing down the mixing context.
   */
  async restoreOriginalTrack(): Promise<void> {
    if (!this.#injected || !this.#originalTrack) return;

    if (this.#tabCaptureStream) {
      for (const t of this.#tabCaptureStream.getTracks()) {
        t.stop();
      }
      this.#tabCaptureStream = null;
    }

    if (this.#mixingContext) {
      await this.#mixingContext.close();
      this.#mixingContext = null;
    }

    this.#mixingDestination = null;
    this.#injected = false;
  }

  /** Check if the virtual track is currently injected. */
  isInjected(): boolean {
    return this.#injected;
  }

  /** Clean up all audio resources. */
  destroy(): void {
    if (this.#tabCaptureStream) {
      for (const t of this.#tabCaptureStream.getTracks()) {
        t.stop();
      }
      this.#tabCaptureStream = null;
    }

    if (this.#mixingContext) {
      void this.#mixingContext.close();
      this.#mixingContext = null;
    }

    this.#mixingDestination = null;
    this.#originalTrack = null;
    this.#injected = false;
  }
}

// ── Generic WebRTC Adapter ──────────────────────────────────

/**
 * For "Force Enable" mode on unknown WebRTC apps.
 * Monitors RTCPeerConnection constructor, attempts replaceTrack()
 * on any detected audio sender.
 */
export class GenericAdapter implements PlatformAdapter {
  readonly platform = 'generic' as const;
  #originalTrack: MediaStreamTrack | null = null;
  #injected = false;
  #cleanupListeners: Array<() => void> = [];

  /**
   * Inject a main-world script that monitors the RTCPeerConnection
   * constructor and captures created peer connections.
   */
  async initialize(): Promise<void> {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const OrigRTCPeerConnection = window.RTCPeerConnection;
        const connections = new Set();

        window.RTCPeerConnection = function(...args) {
          const pc = new OrigRTCPeerConnection(...args);
          connections.add(pc);
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'closed') connections.delete(pc);
          });
          window.postMessage({
            source: 'voicebridge',
            type: 'peer-connection-created',
            payload: { count: connections.size }
          }, window.location.origin);
          return pc;
        };
        window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;

        window.addEventListener('message', (event) => {
          if (event.origin !== window.location.origin) return;
          const data = event.data;
          if (data?.source !== 'voicebridge') return;

          if (data.type === 'inject-virtual-track') {
            let replaced = false;
            for (const pc of connections) {
              const senders = pc.getSenders();
              for (const sender of senders) {
                if (sender.track?.kind === 'audio') {
                  window.__voicebridgeOriginalTrack = sender.track;
                  sender.replaceTrack(null).then(() => {
                    replaced = true;
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-injected',
                      payload: { success: true }
                    }, window.location.origin);
                  }).catch((err) => {
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-injected',
                      payload: { success: false, error: err.message }
                    }, window.location.origin);
                  });
                  break;
                }
              }
              if (replaced) break;
            }
            if (!replaced && connections.size === 0) {
              window.postMessage({
                source: 'voicebridge',
                type: 'track-injected',
                payload: { success: false, error: 'No peer connections found' }
              }, window.location.origin);
            }
          }

          if (data.type === 'restore-original-track') {
            const origTrack = window.__voicebridgeOriginalTrack;
            let restored = false;
            for (const pc of connections) {
              const senders = pc.getSenders();
              for (const sender of senders) {
                if (sender.track === null || sender.track?.kind === 'audio') {
                  sender.replaceTrack(origTrack || null).then(() => {
                    restored = true;
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-restored',
                      payload: { success: true }
                    }, window.location.origin);
                  }).catch(() => {
                    window.postMessage({
                      source: 'voicebridge',
                      type: 'track-restored',
                      payload: { success: true }
                    }, window.location.origin);
                  });
                  break;
                }
              }
              if (restored) break;
            }
            if (!restored) {
              window.postMessage({
                source: 'voicebridge',
                type: 'track-restored',
                payload: { success: true }
              }, window.location.origin);
            }
          }
        });
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    const removeListener = onPageMessage('peer-connection-created', (_payload) => {
      // Peer connection detected — ready for track injection.
    });
    this.#cleanupListeners.push(removeListener);
  }

  /**
   * Replace the audio sender track on captured RTCPeerConnections.
   */
  async injectVirtualTrack(track: MediaStreamTrack): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('GenericAdapter: injectVirtualTrack timed out'));
      }, 5000);

      const removeListener = onPageMessage('track-injected', (payload) => {
        clearTimeout(timeout);
        removeListener();
        const result = payload as { success: boolean; error?: string };
        if (result.success) {
          this.#originalTrack = track;
          this.#injected = true;
          resolve();
        } else {
          reject(new Error(result.error ?? 'GenericAdapter: injection failed'));
        }
      });
      this.#cleanupListeners.push(removeListener);

      postToPage('inject-virtual-track', { trackId: track.id });
    });
  }

  /**
   * Restore the original microphone track on the RTCPeerConnection.
   */
  async restoreOriginalTrack(): Promise<void> {
    if (!this.#injected || !this.#originalTrack) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#injected = false;
        resolve();
      }, 2000);

      const removeListener = onPageMessage('track-restored', () => {
        clearTimeout(timeout);
        removeListener();
        this.#injected = false;
        resolve();
      });
      this.#cleanupListeners.push(removeListener);

      postToPage('restore-original-track', { trackId: this.#originalTrack?.id });
    });
  }

  /** Check if the virtual track is currently injected. */
  isInjected(): boolean {
    return this.#injected;
  }

  /** Clean up all injected scripts, listeners, and references. */
  destroy(): void {
    for (const cleanup of this.#cleanupListeners) {
      cleanup();
    }
    this.#cleanupListeners = [];
    this.#originalTrack = null;
    this.#injected = false;
  }
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Create the appropriate PlatformAdapter for the detected platform.
 * Returns null for 'none' (no meeting detected).
 */
export function createPlatformAdapter(platform: MeetingPlatform): PlatformAdapter | null {
  switch (platform) {
    case 'google-meet': return new GoogleMeetAdapter();
    case 'teams': return new TeamsAdapter();
    case 'discord': return new DiscordAdapter();
    case 'zoom': return new ZoomAdapter();
    case 'generic': return new GenericAdapter();
    case 'none': return null;
  }
}
