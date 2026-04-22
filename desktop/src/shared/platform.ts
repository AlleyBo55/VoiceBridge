/**
 * Platform-specific utilities for VoiceBridge Desktop.
 * Maps OS to config directories, driver implementations, and keyboard shortcuts.
 */

import { join } from 'path';
import { homedir } from 'os';

// ── Config Directory ────────────────────────────────────────

/**
 * Get the platform-appropriate config directory path.
 *
 * @param platform - The OS platform identifier
 * @returns Absolute path to the VoiceBridge config directory
 */
export function getConfigDir(
  platform: NodeJS.Platform = process.platform
): string {
  switch (platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'VoiceBridge');
    case 'win32':
      return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'VoiceBridge');
    case 'linux':
      return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'voicebridge');
    default:
      return join(homedir(), '.voicebridge');
  }
}

// ── Driver Class Mapping ────────────────────────────────────

export type DriverType = 'coreaudio' | 'wasapi' | 'pulseaudio' | 'unsupported';

/**
 * Get the correct driver implementation type for the current platform.
 *
 * @param platform - The OS platform identifier
 * @returns The driver type string for the platform
 */
export function getDriverType(
  platform: NodeJS.Platform = process.platform
): DriverType {
  switch (platform) {
    case 'darwin': return 'coreaudio';
    case 'win32': return 'wasapi';
    case 'linux': return 'pulseaudio';
    default: return 'unsupported';
  }
}


// ── Keyboard Shortcuts ──────────────────────────────────────

/**
 * Get the platform-appropriate keyboard shortcut string.
 * Substitutes Cmd for Ctrl on macOS.
 *
 * @param shortcut - Shortcut template using CmdOrCtrl prefix
 * @param platform - The OS platform identifier
 * @returns Platform-specific shortcut string
 */
export function getKeyboardShortcut(
  shortcut: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'darwin') {
    return shortcut.replace(/CmdOrCtrl/g, 'Cmd').replace(/Ctrl/g, 'Cmd');
  }
  return shortcut.replace(/CmdOrCtrl/g, 'Ctrl');
}

/**
 * Get the display label for a keyboard shortcut (human-readable).
 *
 * @param shortcut - Shortcut template using CmdOrCtrl prefix
 * @param platform - The OS platform identifier
 * @returns Human-readable shortcut label
 */
export function getShortcutLabel(
  shortcut: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'darwin') {
    return shortcut
      .replace(/CmdOrCtrl/g, '⌘')
      .replace(/Ctrl/g, '⌘')
      .replace(/Shift/g, '⇧')
      .replace(/Alt/g, '⌥')
      .replace(/\+/g, '');
  }
  return shortcut
    .replace(/CmdOrCtrl/g, 'Ctrl')
    .replace(/\+/g, ' + ');
}

// ── Auto-Start Paths ────────────────────────────────────────

/**
 * Get the auto-start configuration path for the current platform.
 *
 * @param platform - The OS platform identifier
 * @returns Path to the auto-start config file, or null if using Electron API
 */
export function getAutoStartPath(
  platform: NodeJS.Platform = process.platform
): string | null {
  switch (platform) {
    case 'darwin':
      // Uses Electron app.setLoginItemSettings() — no file path needed
      return null;
    case 'win32':
      // Uses Electron app.setLoginItemSettings() — no file path needed
      return null;
    case 'linux':
      return join(
        process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
        'autostart',
        'voicebridge.desktop'
      );
    default:
      return null;
  }
}