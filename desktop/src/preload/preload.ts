/**
 * Electron preload script — exposes typed contextBridge API.
 * SECURITY: Renderer has NO access to Node.js APIs, native addon,
 * API keys, or raw IPC. Only these methods are exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AudioDeviceInfo, DriverStatus, DriverInstallResult,
  Language, DebugLogEntry,
} from '../shared/types.js';

/** VoiceBridge API exposed to the renderer via contextBridge */
const api = {
  // ── Session ─────────────────────────────────────────────
  startSession: (params: { sourceLanguage: string; targetLanguage: string }): Promise<void> =>
    ipcRenderer.invoke('session:start', params),
  stopSession: (reason: string): Promise<void> =>
    ipcRenderer.invoke('session:stop', { reason }),

  // ── Settings ────────────────────────────────────────────
  getSetting: (key: string): Promise<unknown> =>
    ipcRenderer.invoke('settings:get', { key }),
  setSetting: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('settings:set', { key, value }),
  exportSettings: (): Promise<string> =>
    ipcRenderer.invoke('settings:export'),
  importSettings: (json: string): Promise<void> =>
    ipcRenderer.invoke('settings:import', json),

  // ── Audio Devices ───────────────────────────────────────
  listDevices: (): Promise<AudioDeviceInfo[]> =>
    ipcRenderer.invoke('devices:list'),
  selectDevice: (deviceId: string): Promise<void> =>
    ipcRenderer.invoke('devices:select', { deviceId }),

  // ── Driver ──────────────────────────────────────────────
  getDriverStatus: (): Promise<DriverStatus> =>
    ipcRenderer.invoke('driver:status'),
  installDriver: (): Promise<DriverInstallResult> =>
    ipcRenderer.invoke('driver:install'),

  // ── Voice Profile ───────────────────────────────────────
  startRecording: (): Promise<void> =>
    ipcRenderer.invoke('voice:start-recording'),
  stopRecording: (): Promise<Blob> =>
    ipcRenderer.invoke('voice:stop-recording'),
  uploadVoice: (): Promise<string> =>
    ipcRenderer.invoke('voice:upload'),
  deleteVoice: (voiceId: string): Promise<void> =>
    ipcRenderer.invoke('voice:delete', { voiceId }),
  previewVoice: (voiceId: string, text: string, language: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('voice:preview', { voiceId, text, language }),

  // ── Languages ───────────────────────────────────────────
  listLanguages: (): Promise<Language[]> =>
    ipcRenderer.invoke('languages:list'),

  // ── Debug ───────────────────────────────────────────────
  getDebugLog: (): Promise<DebugLogEntry[]> =>
    ipcRenderer.invoke('debug:get-log'),

  // ── Events (main → renderer) ────────────────────────────
  on: (event: string, callback: (...args: unknown[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
};

contextBridge.exposeInMainWorld('voicebridge', api);

/** Type declaration for the renderer */
export type VoiceBridgeAPI = typeof api;
