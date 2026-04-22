/**
 * VoiceBridge Desktop — Electron main process entry point.
 * Initializes system tray, main window, native addon, pipeline,
 * settings store, and IPC handlers.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut } from 'electron';
import { join } from 'path';
import { MockNativeAddon } from '../native/native-addon.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { DesktopPipeline } from './desktop-pipeline.js';
import { DesktopDebugLog } from './desktop-debug-log.js';
import { DriverInstaller } from './driver-installer.js';
import { AutoStartManager } from './auto-start.js';
import { LanguageService } from './language-service.js';
import { PanicStop } from './panic-stop.js';
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

// ── Window Creation ─────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const isDev = process.env['NODE_ENV'] === 'development';

  const win = new BrowserWindow({
    width: isDev ? 800 : 360,
    height: isDev ? 600 : 480,
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
    return driverInstaller.install();
  });
  handleInvoke('driver:uninstall', async () => {
    return driverInstaller.uninstall();
  });

  // Languages
  handleInvoke('languages:list', async () => {
    return languageService.getLanguages();
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
  driverInstaller = new DriverInstaller(nativeAddon);
  autoStart = new AutoStartManager();
  languageService = new LanguageService(settings);

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
