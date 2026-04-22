/**
 * Auto-start manager for VoiceBridge Desktop.
 * Handles OS-specific login item registration.
 */

import { app } from 'electron';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { getAutoStartPath } from '../shared/platform.js';

// ── Auto-Start Manager ──────────────────────────────────────

export class AutoStartManager {
  /** Check if auto-start is enabled. */
  async isEnabled(): Promise<boolean> {
    if (process.platform === 'linux') {
      const path = getAutoStartPath('linux');
      return path !== null && existsSync(path);
    }
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  }

  /** Enable auto-start on login. */
  async enable(): Promise<void> {
    if (process.platform === 'linux') {
      const path = getAutoStartPath('linux');
      if (!path) return;
      await mkdir(dirname(path), { recursive: true });
      const desktopEntry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=VoiceBridge',
        'Comment=Real-time voice translation',
        `Exec=${process.execPath}`,
        'Terminal=false',
        'StartupNotify=false',
        'X-GNOME-Autostart-enabled=true',
      ].join('\n');
      await writeFile(path, desktopEntry, 'utf8');
      return;
    }

    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });
  }

  /** Disable auto-start on login. */
  async disable(): Promise<void> {
    if (process.platform === 'linux') {
      const path = getAutoStartPath('linux');
      if (path && existsSync(path)) {
        await unlink(path);
      }
      return;
    }

    app.setLoginItemSettings({ openAtLogin: false });
  }
}
