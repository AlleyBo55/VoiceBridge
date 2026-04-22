/**
 * Virtual microphone driver installer — REAL implementation.
 *
 * macOS:   Installs BlackHole 2ch via Homebrew (CoreAudio HAL plugin).
 * Linux:   Creates PulseAudio/PipeWire null sink + loopback (user-space).
 * Windows: Guides user to install VB-CABLE (requires manual download).
 *
 * Every error includes a human-readable message + resolution steps.
 * Persists install state in settings so it survives restarts.
 */

import { execSync, exec } from 'child_process';
import type { NativeAudioAddon } from '../native/native-addon.js';
import type { DriverStatus, DriverInstallResult } from '../shared/types.js';
import { DesktopSettingsStore } from './desktop-settings-store.js';
import { DesktopDebugLog } from './desktop-debug-log.js';

// ── Driver Installer ────────────────────────────────────────

export class DriverInstaller {
  #nativeAddon: NativeAudioAddon;
  #settings: DesktopSettingsStore;
  #debugLog: DesktopDebugLog;
  #installed = false;
  #driverName = '';

  /** Called during install with progress updates. Set by the caller. */
  onProgress: ((percent: number, message: string) => void) | null = null;

  constructor(nativeAddon: NativeAudioAddon, settings: DesktopSettingsStore, debugLog: DesktopDebugLog) {
    this.#nativeAddon = nativeAddon;
    this.#settings = settings;
    this.#debugLog = debugLog;
  }

  /** Load persisted state and verify the driver is actually present on the OS. */
  async initialize(): Promise<void> {
    const version = await this.#settings.get('driverVersion');
    const hadDriver = version !== null && version.length > 0;

    const realCheck = this.#checkRealDriver();
    this.#installed = realCheck.installed;
    this.#driverName = realCheck.name;

    if (this.#installed && !hadDriver) {
      await this.#settings.set('driverVersion', '1.0.0');
      await this.#settings.flush();
    } else if (!this.#installed && hadDriver) {
      await this.#settings.set('driverVersion', null);
      await this.#settings.flush();
    }

    this.#debugLog.log('info', 'audio',
      `Driver check: ${this.#installed ? `installed (${this.#driverName})` : 'not installed'}`);
  }

  checkInstalled(): DriverStatus {
    if (this.#installed) {
      return { state: 'installed', version: '1.0.0', active: true, sampleRate: 48000 };
    }
    return { state: 'not-installed' };
  }

  /** Get the detected driver name (e.g. "BlackHole", "PulseAudio Sink"). */
  getDriverName(): string {
    return this.#driverName;
  }

  async install(): Promise<DriverInstallResult> {
    const platform = process.platform;
    this.#debugLog.log('info', 'audio', `Installing virtual mic driver on ${platform}`);

    try {
      let result: DriverInstallResult;

      switch (platform) {
        case 'darwin':  result = await this.#installMacOS(); break;
        case 'linux':   result = await this.#installLinux(); break;
        case 'win32':   result = this.#installWindows(); break;
        default:
          result = { success: false, error: `Unsupported platform: ${platform}` };
      }

      if (result.success) {
        this.#installed = true;
        await this.#settings.set('driverVersion', '1.0.0');
        await this.#settings.flush();
        // Re-detect the name
        const check = this.#checkRealDriver();
        this.#driverName = check.name;
        this.#debugLog.log('info', 'audio', `Driver installed: ${this.#driverName}`);
      } else {
        this.#debugLog.log('error', 'audio', `Driver install failed: ${result.error}`);
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#debugLog.log('error', 'audio', `Driver install error: ${msg}`);
      return { success: false, error: msg };
    }
  }

  async uninstall(): Promise<boolean> {
    try {
      if (process.platform === 'darwin') {
        execSync('brew uninstall blackhole-2ch 2>/dev/null || true', { timeout: 30000 });
      } else if (process.platform === 'linux') {
        execSync('pactl unload-module module-null-sink 2>/dev/null || true', { timeout: 5000 });
      }
      this.#installed = false;
      this.#driverName = '';
      await this.#settings.set('driverVersion', null);
      await this.#settings.flush();
      return true;
    } catch { return false; }
  }

  verifyDevicePresent(): boolean {
    return this.#checkRealDriver().installed;
  }

  // ── Detection ─────────────────────────────────────────────

  #checkRealDriver(): { installed: boolean; name: string } {
    try {
      if (process.platform === 'darwin') return this.#detectMacOS();
      if (process.platform === 'linux') return this.#detectLinux();
      if (process.platform === 'win32') return this.#detectWindows();
    } catch { /* detection failed */ }
    return { installed: false, name: '' };
  }

  #detectMacOS(): { installed: boolean; name: string } {
    // Check brew first — most reliable since we install via brew
    try {
      const brewList = execSync('brew list --cask blackhole-2ch 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      if (brewList.trim().length > 0) return { installed: true, name: 'BlackHole 2ch' };
    } catch { /* not installed via brew */ }

    // Check system_profiler for any virtual audio device
    try {
      const output = execSync('system_profiler SPAudioDataType 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const known = ['BlackHole', 'Soundflower', 'Loopback', 'VB-Cable', 'VoiceBridge'];
      for (const name of known) {
        if (output.includes(name)) return { installed: true, name };
      }
    } catch { /* profiler failed */ }

    // Check HAL plugins directory
    try {
      const hal = execSync('ls /Library/Audio/Plug-Ins/HAL/ 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      if (hal.includes('BlackHole')) return { installed: true, name: 'BlackHole' };
      if (hal.includes('Soundflower')) return { installed: true, name: 'Soundflower' };
    } catch { /* no HAL dir */ }

    return { installed: false, name: '' };
  }

  #detectLinux(): { installed: boolean; name: string } {
    // Check PipeWire first (modern Ubuntu 22.04+)
    try {
      const pw = execSync('pw-cli list-objects 2>/dev/null | grep -i voicebridge', { encoding: 'utf8', timeout: 3000 });
      if (pw.trim().length > 0) return { installed: true, name: 'VoiceBridge (PipeWire)' };
    } catch { /* no pipewire or no match */ }

    // Check PulseAudio
    try {
      const pa = execSync('pactl list short sinks 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      if (pa.includes('voicebridge')) return { installed: true, name: 'VoiceBridge (PulseAudio)' };
    } catch { /* no pulseaudio */ }

    return { installed: false, name: '' };
  }

  #detectWindows(): { installed: boolean; name: string } {
    try {
      const ps = execSync(
        'powershell -Command "Get-AudioDevice -List 2>$null | Select-Object -ExpandProperty Name"',
        { encoding: 'utf8', timeout: 5000 }
      );
      if (ps.includes('CABLE') || ps.includes('VB-Audio')) return { installed: true, name: 'VB-CABLE' };
      if (ps.includes('VoiceBridge')) return { installed: true, name: 'VoiceBridge' };
    } catch { /* powershell or module not available */ }
    return { installed: false, name: '' };
  }

  // ── macOS Install ─────────────────────────────────────────

  async #installMacOS(): Promise<DriverInstallResult> {
    const p = (pct: number, msg: string) => this.onProgress?.(pct, msg);

    // 1. Check Homebrew
    p(5, 'Checking for Homebrew...');
    try {
      execSync('which brew', { encoding: 'utf8', timeout: 3000 });
    } catch {
      p(0, 'Homebrew not found');
      return {
        success: false,
        error: [
          'Homebrew is not installed.',
          '',
          'To fix this:',
          '1. Open Terminal',
          '2. Run: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '3. Restart VoiceBridge and try again',
          '',
          'Or install BlackHole manually:',
          'https://existential.audio/blackhole/',
        ].join('\n'),
      };
    }

    // 2. Check if already installed
    p(10, 'Checking existing installation...');
    try {
      const check = execSync('brew list --cask blackhole-2ch 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      if (check.trim().length > 0) {
        p(100, 'Already installed');
        return { success: true };
      }
    } catch { /* not installed — continue */ }

    // 3. Install via brew — BlackHole is a cask that needs sudo for the pkg installer.
    // We open a real Terminal window so the user can enter their password.
    p(15, 'Opening Terminal for installation...');
    this.#debugLog.log('info', 'audio', 'Running: brew install --cask blackhole-2ch (in Terminal)');

    return new Promise((resolve) => {
      // Use osascript to open Terminal with the brew command
      const script = `
        tell application "Terminal"
          activate
          do script "echo '=== VoiceBridge: Installing BlackHole virtual audio driver ===' && brew install --cask blackhole-2ch && echo '' && echo '✅ Done! You can close this window.' || echo '' && echo '❌ Install failed. Check the error above.'"
        end tell
      `.trim();

      const { spawn: spawnProcess } = require('child_process') as typeof import('child_process');
      const child = spawnProcess('osascript', ['-e', script], { stdio: 'ignore' });

      child.on('error', (err: Error) => {
        p(0, 'Failed to open Terminal');
        resolve({
          success: false,
          error: [
            'Could not open Terminal for installation.',
            '',
            'Please install manually:',
            '1. Open Terminal',
            '2. Run: brew install --cask blackhole-2ch',
            '3. Enter your password when prompted',
            '4. Reboot your Mac',
            '5. Restart VoiceBridge',
          ].join('\n'),
        });
      });

      child.on('close', () => {
        p(30, 'Terminal opened — enter your password if prompted...');
      });

      // Poll for installation completion
      let pollCount = 0;
      const maxPolls = 120; // 2 minutes at 1s intervals
      const pollTimer = setInterval(() => {
        pollCount++;

        // Update progress based on time
        const pct = Math.min(90, 30 + Math.floor((pollCount / maxPolls) * 60));
        if (pollCount < 10) p(pct, 'Waiting for password prompt...');
        else if (pollCount < 30) p(pct, 'Installing BlackHole driver...');
        else if (pollCount < 60) p(pct, 'Still installing...');
        else p(pct, 'Taking a while — check Terminal window');

        // Check if installed
        try {
          const check = execSync('brew list --cask blackhole-2ch 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
          if (check.trim().length > 0) {
            clearInterval(pollTimer);
            p(100, 'Installed! Restart your computer. Select "BlackHole 2ch" as mic in meeting apps.');
            resolve({
              success: true,
              requiresReboot: true,
            });
            return;
          }
        } catch { /* not yet */ }

        // Timeout
        if (pollCount >= maxPolls) {
          clearInterval(pollTimer);
          // One final check
          const finalCheck = this.#checkRealDriver();
          if (finalCheck.installed) {
            p(100, 'Installed!');
            resolve({ success: true });
          } else {
            p(0, 'Timed out');
            resolve({
              success: false,
              error: [
                'Installation timed out.',
                '',
                'Check the Terminal window for errors.',
                'If it asks for a password, enter it and wait.',
                '',
                'Or install manually:',
                '  brew install --cask blackhole-2ch',
                '',
                'After install, reboot your Mac.',
              ].join('\n'),
            });
          }
        }
      }, 1000);
    });
  }

  // ── Linux Install ─────────────────────────────────────────

  async #installLinux(): Promise<DriverInstallResult> {
    const p = (pct: number, msg: string) => this.onProgress?.(pct, msg);
    const hasPipeWire = this.#commandExists('pw-cli');
    const hasPulseAudio = this.#commandExists('pactl');

    if (!hasPipeWire && !hasPulseAudio) {
      return {
        success: false,
        error: [
          'No supported audio system found.',
          '',
          'VoiceBridge requires PulseAudio or PipeWire.',
          '',
          'Ubuntu/Debian: sudo apt install pulseaudio',
          'Fedora: sudo dnf install pulseaudio',
          'Arch: sudo pacman -S pulseaudio',
          '',
          'Then restart VoiceBridge.',
        ].join('\n'),
      };
    }

    // PipeWire (modern Ubuntu 22.04+, Fedora 34+)
    if (hasPipeWire) {
      try {
        // PipeWire uses pactl compatibility layer
        execSync(
          'pactl load-module module-null-sink sink_name=voicebridge sink_properties=device.description="VoiceBridge\\ Mic"',
          { encoding: 'utf8', timeout: 5000 }
        );
        execSync(
          'pactl load-module module-loopback source=voicebridge.monitor sink_input_properties=media.name="VoiceBridge\\ Loopback"',
          { encoding: 'utf8', timeout: 5000 }
        );
        this.#driverName = 'VoiceBridge (PipeWire)';
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes('Connection refused') || msg.includes('No PulseAudio')) {
          return {
            success: false,
            error: [
              'PipeWire/PulseAudio daemon is not running.',
              '',
              'To fix this:',
              '  systemctl --user start pipewire pipewire-pulse',
              '',
              'To make it permanent:',
              '  systemctl --user enable pipewire pipewire-pulse',
            ].join('\n'),
          };
        }

        if (msg.includes('Module initialization failed')) {
          return {
            success: false,
            error: [
              'Audio module failed to load.',
              '',
              'This can happen if the module is already loaded.',
              'Try: pactl unload-module module-null-sink',
              'Then click Install Driver again.',
            ].join('\n'),
          };
        }

        return {
          success: false,
          error: [
            'Failed to create virtual audio device.',
            '',
            'Try manually in terminal:',
            '  pactl load-module module-null-sink sink_name=voicebridge sink_properties=device.description="VoiceBridge Mic"',
            '',
            `Error: ${msg.slice(0, 200)}`,
          ].join('\n'),
        };
      }
    }

    // PulseAudio (older systems)
    try {
      execSync(
        'pactl load-module module-null-sink sink_name=voicebridge sink_properties=device.description="VoiceBridge\\ Mic"',
        { encoding: 'utf8', timeout: 5000 }
      );
      execSync(
        'pactl load-module module-loopback source=voicebridge.monitor sink_input_properties=media.name="VoiceBridge\\ Loopback"',
        { encoding: 'utf8', timeout: 5000 }
      );
      this.#driverName = 'VoiceBridge (PulseAudio)';
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('Connection refused') || msg.includes('No PulseAudio')) {
        return {
          success: false,
          error: [
            'PulseAudio daemon is not running.',
            '',
            'To fix this:',
            '  pulseaudio --start',
            '',
            'If that fails:',
            '  sudo apt install pulseaudio  (Ubuntu/Debian)',
            '  sudo dnf install pulseaudio  (Fedora)',
          ].join('\n'),
        };
      }

      return {
        success: false,
        error: [
          'Failed to create PulseAudio virtual device.',
          '',
          'Try manually:',
          '  pactl load-module module-null-sink sink_name=voicebridge',
          '',
          `Error: ${msg.slice(0, 200)}`,
        ].join('\n'),
      };
    }
  }

  // ── Windows Install ───────────────────────────────────────

  #installWindows(): DriverInstallResult {
    return {
      success: false,
      error: [
        'Windows requires a virtual audio cable driver.',
        '',
        'Install VB-CABLE (free):',
        '1. Download from https://vb-audio.com/Cable/',
        '2. Extract the ZIP file',
        '3. Right-click VBCABLE_Setup_x64.exe → Run as Administrator',
        '4. Click "Install Driver" and accept the prompt',
        '5. Restart your computer',
        '6. Restart VoiceBridge',
        '',
        'After install, select "CABLE Output" as your mic in meeting apps.',
      ].join('\n'),
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  #commandExists(cmd: string): boolean {
    try {
      execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}
