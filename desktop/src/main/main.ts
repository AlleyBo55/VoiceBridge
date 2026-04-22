/**
 * VoiceBridge Desktop — Electron main process entry point.
 * Initializes system tray, main window, native addon, pipeline,
 * settings store, and IPC handlers.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain } from 'electron';
import { join } from 'path';
import { MockNativeAddon } from '../native/native-addon.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { DesktopPipeline } from './desktop-pipeline.js';
import { DesktopDebugLog } from './desktop-debug-log.js';
import { DriverInstaller } from './driver-installer.js';
import { AutoStartManager } from './auto-start.js';
import { LanguageService } from './language-service.js';
import { PanicStop } from './panic-stop.js';
import { DesktopVoiceProfile } from './desktop-voice-profile.js';
import { handleInvoke, sendToRenderer } from './electron-ipc.js';

// ── State ───────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const nativeAddon = new MockNativeAddon();
const debugLog = new DesktopDebugLog();
const settings = new DesktopSettingsStore();
let pipeline: DesktopPipeline;
let driverInstaller: DriverInstaller;
let autoStart: AutoStartManager;
let languageService: LanguageService;
let panicStop: PanicStop;
let voiceProfile: DesktopVoiceProfile;

// ── Window Creation ─────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const isDev = process.env['NODE_ENV'] === 'development';

  const win = new BrowserWindow({
    width: isDev ? 900 : 360,
    height: isDev ? 750 : 480,
    show: false,
    frame: isDev,
    resizable: isDev,
    skipTaskbar: !isDev,
    transparent: false,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      sandbox: false,
    },
  });

  // Load renderer
  if (process.env['NODE_ENV'] === 'development') {
    void win.loadURL('http://localhost:5173/src/renderer/index.html');
    // Open DevTools in dev mode
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'src', 'renderer', 'index.html'));
  }

  // Hide on blur (click outside) — disabled in dev for DevTools usability
  if (process.env['NODE_ENV'] !== 'development') {
    win.on('blur', () => {
      win.hide();
    });
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

// ── Tray ────────────────────────────────────────────────────

function createTray(): Tray {
  // Use a 16x16 empty image as placeholder
  const icon = nativeImage.createEmpty();
  const t = new Tray(icon);

  t.setToolTip('VoiceBridge');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Toggle Translation',
      click: async () => {
        if (pipeline.isActive()) {
          await pipeline.stopSession('user');
        } else {
          const src = await settings.get('sourceLanguage');
          const tgt = await settings.get('targetLanguage');
          await pipeline.startSession({ sourceLanguage: src, targetLanguage: tgt });
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          // TODO: Navigate to settings view
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  t.setContextMenu(contextMenu);

  // Click to show/hide window
  t.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });

  return t;
}

// ── IPC Handlers ────────────────────────────────────────────

function registerIPCHandlers(): void {
  // Session
  handleInvoke('session:start', async (params) => {
    await pipeline.startSession(params);
  });
  handleInvoke('session:stop', async (params) => {
    await pipeline.stopSession(params.reason);
  });

  // Settings
  handleInvoke('settings:get', async (params) => {
    return settings.get(params.key as keyof import('../shared/types.js').DesktopSettingsSchema);
  });
  handleInvoke('settings:set', async (params) => {
    await settings.set(
      params.key as keyof import('../shared/types.js').DesktopSettingsSchema,
      params.value as import('../shared/types.js').DesktopSettingsSchema[keyof import('../shared/types.js').DesktopSettingsSchema],
    );
  });
  handleInvoke('settings:export', async () => {
    return settings.exportSettings();
  });
  handleInvoke('settings:import', async (json) => {
    await settings.importSettings(json as string);
  });

  // Devices
  handleInvoke('devices:list', () => {
    return nativeAddon.enumerateInputDevices();
  });
  handleInvoke('devices:select', async (params) => {
    pipeline.getAudioRouter().setCaptureDevice(params.deviceId);
    await settings.set('selectedMicDeviceId', params.deviceId);
  });

  // Driver
  handleInvoke('driver:status', () => {
    return driverInstaller.checkInstalled();
  });
  handleInvoke('driver:install', async () => {
    // Stream progress to renderer
    driverInstaller.onProgress = (percent, message) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('driver:install-progress', { percent, message });
      }
    };
    const result = await driverInstaller.install();
    driverInstaller.onProgress = null;
    return result;
  });
  handleInvoke('driver:uninstall', async () => {
    return driverInstaller.uninstall();
  });

  // Key validation — registered directly since these aren't in the typed channel map
  ipcMain.handle('validate:elevenlabs', async (_event, params: { key: string }) => {
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': params.key },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid API key' };
      if (res.status === 402) return { valid: false, error: 'Quota exhausted' };
      return { valid: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  });
  ipcMain.handle('validate:llm', async (_event, params: { provider: string; key: string }) => {
    try {
      let url: string;
      const headers: Record<string, string> = {};
      if (params.provider === 'anthropic') {
        url = 'https://api.anthropic.com/v1/messages';
        headers['x-api-key'] = params.key;
        headers['anthropic-version'] = '2023-06-01';
      } else if (params.provider === 'openrouter') {
        url = 'https://openrouter.ai/api/v1/models';
        headers['Authorization'] = `Bearer ${params.key}`;
      } else {
        url = 'https://api.openai.com/v1/models';
        headers['Authorization'] = `Bearer ${params.key}`;
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid API key' };
      return { valid: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  });
  // Fetch available models for a provider (for model selector)
  ipcMain.handle('models:list', async (_event, params: { provider: string; key: string }) => {
    try {
      let url: string;
      const headers: Record<string, string> = {};
      if (params.provider === 'openrouter') {
        url = 'https://openrouter.ai/api/v1/models';
        headers['Authorization'] = `Bearer ${params.key}`;
      } else if (params.provider === 'openai') {
        url = 'https://api.openai.com/v1/models';
        headers['Authorization'] = `Bearer ${params.key}`;
      } else {
        // Anthropic doesn't have a models list endpoint — return hardcoded
        return [
          { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
          { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
        ];
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const data = await res.json() as { data?: Array<{ id: string; name?: string }> };
      const models = data.data ?? [];
      // Filter to chat/completion models, return top 30
      return models
        .filter((m: { id: string }) => {
          const id = m.id.toLowerCase();
          // OpenRouter: show all. OpenAI: filter to gpt models
          if (params.provider === 'openrouter') return true;
          return id.includes('gpt') || id.includes('o1') || id.includes('o3');
        })
        .slice(0, 30)
        .map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }));
    } catch {
      return [];
    }
  });

  // Languages
  handleInvoke('languages:list', async () => {
    return languageService.getLanguages();
  });

  // Voice profile
  handleInvoke('voice:start-recording', () => {
    voiceProfile.startRecording();
  });
  handleInvoke('voice:stop-recording', async (params) => {
    // Renderer sends audio data as base64 string via IPC
    const audioData = params as { audioBase64: string };
    const buffer = Buffer.from(audioData.audioBase64, 'base64');
    return voiceProfile.stopRecording(buffer);
  });
  handleInvoke('voice:upload', async () => {
    return voiceProfile.upload();
  });
  handleInvoke('voice:delete', async (params) => {
    await voiceProfile.deleteProfile(params.voiceId);
  });
  handleInvoke('voice:preview', async (params) => {
    return voiceProfile.preview(params.voiceId, params.text, params.language);
  });
  ipcMain.handle('voice:list', async () => {
    return voiceProfile.listVoices();
  });
  ipcMain.handle('voice:set-active', async (_event, params: { voiceId: string }) => {
    await voiceProfile.setActiveVoice(params.voiceId);
  });
  ipcMain.handle('voice:get-active', async () => {
    return voiceProfile.getActiveVoiceId();
  });

  // Debug
  handleInvoke('debug:get-log', () => {
    return debugLog.getEntries();
  });
}

// ── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  // Initialize settings
  await settings.initialize();
  await settings.initializeInstall();

  // Initialize services
  driverInstaller = new DriverInstaller(nativeAddon, settings, debugLog);
  await driverInstaller.initialize();
  autoStart = new AutoStartManager();
  languageService = new LanguageService(settings);
  voiceProfile = new DesktopVoiceProfile(settings, debugLog);

  // Create window and tray
  mainWindow = createMainWindow();
  tray = createTray();

  // Initialize pipeline
  pipeline = new DesktopPipeline(nativeAddon, settings, mainWindow, debugLog);
  panicStop = new PanicStop(pipeline, debugLog);
  panicStop.register();

  // Register IPC handlers
  registerIPCHandlers();

  // Check driver status
  const driverStatus = driverInstaller.checkInstalled();
  if (driverStatus.state === 'not-installed') {
    debugLog.log('info', 'state', 'Virtual mic driver not installed');
  }

  // Auto-start check
  const isAutoStart = app.getLoginItemSettings().wasOpenedAtLogin;
  if (isAutoStart) {
    debugLog.log('info', 'state', 'Launched via auto-start');
  } else {
    mainWindow.show();
  }

  debugLog.log('info', 'state', 'VoiceBridge Desktop initialized', {
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  });
});

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
});

app.on('before-quit', async () => {
  panicStop?.unregister();
  globalShortcut.unregisterAll();
  if (pipeline?.isActive()) {
    await pipeline.stopSession('app-quit');
  }
  await settings.flush();
});

// macOS: re-create window when dock icon clicked
app.on('activate', () => {
  if (!mainWindow) {
    mainWindow = createMainWindow();
    pipeline?.setMainWindow(mainWindow);
  }
  mainWindow.show();
});
