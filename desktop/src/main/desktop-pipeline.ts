/**
 * Desktop pipeline adapter.
 * Wraps the existing PipelineOrchestrator with Electron-specific wiring.
 * Replaces chrome.runtime.sendMessage with Electron IPC,
 * AudioCaptureModule with AudioRouter + NativeAddon,
 * AudioOutputModule with NativeAddon.writeVirtualMic.
 */

import type { BrowserWindow } from 'electron';
import type { NativeAudioAddon } from '../native/native-addon.js';
import type {
  SessionState, LatencyMeasurement, DegradationLevel,
  ServiceConnectionState, PipelineStage, VADState,
} from '../shared/types.js';
import { AudioRouter } from './audio-router.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { sendToRenderer } from './electron-ipc.js';
import { DesktopDebugLog } from './desktop-debug-log.js';
import { DesktopLatencyMonitor } from './desktop-latency.js';

// ── Constants ───────────────────────────────────────────────

const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // "George" built-in voice
const STT_TIMEOUT_MS = 5000;
const TRANSLATION_TIMEOUT_MS = 3000;
const TTS_TIMEOUT_MS = 3000;
const MAX_QUEUE_SIZE = 3;
const MAX_ACTIVE_UTTERANCES = 10;

// ── Desktop Pipeline ────────────────────────────────────────

export class DesktopPipeline {
  #audioRouter: AudioRouter;
  #nativeAddon: NativeAudioAddon;
  #settings: DesktopSettingsStore;
  #mainWindow: BrowserWindow | null;
  #debugLog: DesktopDebugLog;
  #latencyMonitor: DesktopLatencyMonitor;
  #sessionActive = false;
  #sessionStartedAt = 0;
  #totalUtterances = 0;
  #droppedUtterances = 0;
  #currentSequenceId = 0;

  constructor(
    nativeAddon: NativeAudioAddon,
    settings: DesktopSettingsStore,
    mainWindow: BrowserWindow | null,
    debugLog: DesktopDebugLog,
  ) {
    this.#nativeAddon = nativeAddon;
    this.#settings = settings;
    this.#mainWindow = mainWindow;
    this.#debugLog = debugLog;
    this.#latencyMonitor = new DesktopLatencyMonitor(mainWindow);
    this.#audioRouter = new AudioRouter(nativeAddon);
  }

  /** Start a translation session. */
  async startSession(params: { sourceLanguage: string; targetLanguage: string }): Promise<void> {
    this.#sessionActive = true;
    this.#sessionStartedAt = Date.now();
    this.#totalUtterances = 0;
    this.#droppedUtterances = 0;
    this.#currentSequenceId = 0;

    const noiseGate = await this.#settings.get('noiseGateThresholdDb');
    const ghostMode = await this.#settings.get('ghostMode');
    const deviceId = await this.#settings.get('selectedMicDeviceId');

    this.#audioRouter.start({
      captureDeviceId: deviceId,
      captureSampleRate: 16000,
      outputSampleRate: 48000,
      noiseGateThresholdDb: noiseGate,
      vadSpeechOnsetMs: 300,
      vadSpeechOffsetMs: 800,
      ghostModeEnabled: ghostMode,
    });

    // Wire audio router callbacks
    this.#audioRouter.onSpeechEnd = () => this.#handleSpeechEnd();
    this.#audioRouter.onVADStateChange = (state: VADState) => {
      sendToRenderer(this.#mainWindow, 'audio:level', {
        rmsDb: this.#audioRouter.getInputLevel(),
        vadState: state.status,
      });
    };

    this.#audioRouter.transitionRouting({ type: 'session_start' });
    this.#emitSessionState(params.sourceLanguage, params.targetLanguage);

    this.#debugLog.log('info', 'pipeline', 'Session started', {
      source: params.sourceLanguage,
      target: params.targetLanguage,
    });
  }

  /** Stop the current session. */
  async stopSession(reason: string): Promise<void> {
    if (!this.#sessionActive) return;
    this.#sessionActive = false;

    this.#audioRouter.transitionRouting({ type: 'session_stop' });
    this.#audioRouter.stop();
    this.#latencyMonitor.clear();

    this.#debugLog.log('info', 'pipeline', `Session stopped: ${reason}`);
    this.#emitSessionState('', '');
  }

  /** Update the main window reference (for IPC). */
  setMainWindow(window: BrowserWindow | null): void {
    this.#mainWindow = window;
    this.#latencyMonitor.setMainWindow(window);
  }

  /** Get the audio router for direct access. */
  getAudioRouter(): AudioRouter {
    return this.#audioRouter;
  }

  /** Check if session is active. */
  isActive(): boolean {
    return this.#sessionActive;
  }

  // ── Private Methods ─────────────────────────────────────────

  #handleSpeechEnd(): void {
    if (!this.#sessionActive) return;
    this.#currentSequenceId++;
    this.#totalUtterances++;

    this.#latencyMonitor.markCaptureEnd(this.#currentSequenceId);

    sendToRenderer(this.#mainWindow, 'pipeline:stage-update', {
      sequenceId: this.#currentSequenceId,
      stage: 'CAPTURED',
    });

    this.#debugLog.log('info', 'pipeline', `Utterance ${this.#currentSequenceId} captured`);
  }

  #emitSessionState(sourceLanguage: string, targetLanguage: string): void {
    const state: SessionState = {
      active: this.#sessionActive,
      startedAt: this.#sessionStartedAt,
      sourceLanguage,
      targetLanguage,
      totalUtterances: this.#totalUtterances,
      droppedUtterances: this.#droppedUtterances,
      currentSequenceId: this.#currentSequenceId,
      voiceTimeMs: 0,
      ttsCharactersUsed: 0,
      sttSecondsUsed: 0,
      llmTokensUsed: 0,
    };
    sendToRenderer(this.#mainWindow, 'session:state-changed', state);
  }
}
