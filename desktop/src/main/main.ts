/**
 * VoiceBridge Desktop — Electron main process entry point.
 * Initializes system tray, main window, native addon, pipeline,
 * settings store, and IPC handlers.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain } from 'electron';
import { join } from 'path';
import { createNativeAddon } from '../native/native-addon.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { DesktopPipeline } from './desktop-pipeline.js';
import { DesktopDebugLog } from './desktop-debug-log.js';
import { DriverInstaller } from './driver-installer.js';
import { AutoStartManager } from './auto-start.js';
import { LanguageService } from './language-service.js';
import { PanicStop } from './panic-stop.js';
import { DesktopVoiceProfile } from './desktop-voice-profile.js';
import { handleInvoke } from './electron-ipc.js';
import { listLLMModels, validateLLMKey } from './llm-catalog.js';
import { validateQwenCredentials } from './qwen-livetranslate-engine.js';
import { validateOpenAITranslateCredentials } from './openai-translate-engine.js';
import { validateGeminiCredentials } from './gemini-translate-engine.js';
import type { LLMProvider } from '../shared/types.js';

const LLM_PROVIDERS: ReadonlySet<string> = new Set<LLMProvider>(['openai', 'anthropic', 'openrouter', 'huggingface', 'custom']);

/** Parse `{ provider, key, baseUrl? }` from the renderer, or null if the provider is unknown. */
function readLLMParams(params: unknown): { provider: LLMProvider; key: string; baseUrl: string } | null {
  if (typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  const provider = p['provider'];
  if (typeof provider !== 'string' || !LLM_PROVIDERS.has(provider)) return null;
  return {
    provider: provider as LLMProvider,
    key: typeof p['key'] === 'string' ? p['key'].trim() : '',
    baseUrl: typeof p['baseUrl'] === 'string' ? p['baseUrl'] : '',
  };
}

// ── State ───────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

/**
 * References retained to prevent garbage collection.
 * Tray and AutoStart must stay alive for the app lifetime.
 */
const retained: { tray: Tray | null; autoStart: AutoStartManager | null } = {
  tray: null,
  autoStart: null,
};

const nativeAddon = createNativeAddon();
const debugLog = new DesktopDebugLog();
const settings = new DesktopSettingsStore();
let pipeline: DesktopPipeline;
let driverInstaller: DriverInstaller;
let languageService: LanguageService;
let panicStop: PanicStop;
let voiceProfile: DesktopVoiceProfile;

// ── Window Creation ─────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const isDev = process.env['NODE_ENV'] === 'development';

  const win = new BrowserWindow({
    width: isDev ? 900 : 420,
    height: isDev ? 750 : 680,
    minWidth: 380,
    minHeight: 520,
    show: false,
    frame: true,
    resizable: true,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#000000',
    titleBarStyle: isDev ? 'default' : 'hiddenInset',
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
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
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

  // Prerequisites — check and install ffmpeg + sox per platform
  ipcMain.handle('prerequisites:check', () => {
    return checkPrerequisites();
  });
  ipcMain.handle('prerequisites:install', async (_event, params: { tool: string }) => {
    return installPrerequisite(params.tool);
  });

  // Push-to-talk
  ipcMain.handle('ptt:press', () => { pipeline.pttPress(); });
  ipcMain.handle('ptt:release', () => {  pipeline.pttRelease(); });
  ipcMain.handle('ptt:toggle-mode', async (_event, params: { enabled: boolean }) => {
    pipeline.setPTTEnabled(params.enabled);
    await settings.set('pushToTalk', params.enabled);
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
  // SECURITY: renderer input is untrusted; only known providers and string fields pass.
  ipcMain.handle('validate:llm', async (_event, params: unknown) => {
    const p = readLLMParams(params);
    if (!p) return { valid: false, error: 'Unknown provider' };
    return validateLLMKey(p.provider, p.key, p.baseUrl);
  });
  // Live model list for the model picker
  ipcMain.handle('models:list', async (_event, params: unknown) => {
    const p = readLLMParams(params);
    return p ? listLLMModels(p.provider, p.key, p.baseUrl) : [];
  });
  // Speech-to-speech engine credentials (opens one short session, sends no audio)
  ipcMain.handle('validate:engine', async (_event, params: unknown) => {
    const p = typeof params === 'object' && params !== null ? params as Record<string, unknown> : {};
    const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
    switch (p['engine']) {
      case 'qwen-livetranslate': {
        const region = str('region');
        if (region !== 'ap-southeast-1' && region !== 'cn-beijing') return { valid: false, error: 'Unknown region' };
        return validateQwenCredentials({ apiKey: str('apiKey'), workspaceId: str('workspaceId'), region });
      }
      case 'openai-realtime-translate':
        return validateOpenAITranslateCredentials({ apiKey: str('apiKey') });
      case 'gemini-live-translate':
        return validateGeminiCredentials({ apiKey: str('apiKey') });
      default:
        return { valid: false, error: 'Unknown engine' };
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
  // @ts-expect-error IPC type mismatch — stopRecording returns metadata, not Blob
  handleInvoke('voice:stop-recording', async (params) => {
    // Renderer sends audio data as base64 string via IPC
    const audioData = params as unknown as { audioBase64: string };
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

// ── Prerequisites ────────────────────────────────────────────

interface PrerequisiteStatus {
  ffmpeg: boolean;
  sox: boolean;
  blackhole: boolean;
  platform: string;
}

function checkPrerequisites(): PrerequisiteStatus {
  const { execSync: ex } = require('child_process') as typeof import('child_process');
  const check = (cmd: string): boolean => {
    try { ex(`which ${cmd}`, { encoding: 'utf8', timeout: 3000 }); return true; } catch { return false; }
  };
  return {
    ffmpeg: check('ffmpeg'),
    sox: check('sox'),
    blackhole: driverInstaller.checkInstalled().state === 'installed',
    platform: process.platform,
  };
}

async function installPrerequisite(tool: string): Promise<{ success: boolean; error?: string; requiresReboot?: boolean }> {
  const { execSync: ex } = require('child_process') as typeof import('child_process');
  const platform = process.platform;

  // Check brew on macOS
  if (platform === 'darwin') {
    try { ex('which brew', { encoding: 'utf8', timeout: 3000 }); } catch {
      return { success: false, error: 'Homebrew not installed.\n\nOpen Terminal and run:\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' };
    }
  }

  try {
    switch (tool) {
      case 'ffmpeg': {
        if (platform === 'darwin') {
          ex('brew install ffmpeg', { encoding: 'utf8', timeout: 120000 });
        } else if (platform === 'linux') {
          ex('sudo apt-get install -y ffmpeg 2>/dev/null || sudo dnf install -y ffmpeg 2>/dev/null || sudo pacman -S --noconfirm ffmpeg 2>/dev/null', { encoding: 'utf8', timeout: 120000 });
        } else {
          return { success: false, error: 'Download ffmpeg from https://ffmpeg.org/download.html and add to PATH.' };
        }
        return { success: true };
      }
      case 'sox': {
        if (platform === 'darwin') {
          ex('brew install sox', { encoding: 'utf8', timeout: 120000 });
        } else if (platform === 'linux') {
          ex('sudo apt-get install -y sox 2>/dev/null || sudo dnf install -y sox 2>/dev/null || sudo pacman -S --noconfirm sox 2>/dev/null', { encoding: 'utf8', timeout: 120000 });
        } else {
          return { success: false, error: 'Download SoX from https://sox.sourceforge.net/ and add to PATH.' };
        }
        return { success: true };
      }
      case 'blackhole': {
        const result = await driverInstaller.install();
        const ret: { success: boolean; error?: string; requiresReboot?: boolean } = { success: result.success };
        if (result.error) ret.error = result.error;
        if (result.requiresReboot) ret.requiresReboot = result.requiresReboot;
        return ret;
      }
      default:
        return { success: false, error: `Unknown tool: ${tool}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  // Initialize settings
  await settings.initialize();
  await settings.initializeInstall();

  // Initialize services
  driverInstaller = new DriverInstaller(nativeAddon, settings, debugLog);
  await driverInstaller.initialize();
  retained.autoStart = new AutoStartManager();
  languageService = new LanguageService(settings);
  voiceProfile = new DesktopVoiceProfile(settings, debugLog);

  // Create window and tray
  mainWindow = createMainWindow();
  retained.tray = createTray();

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
