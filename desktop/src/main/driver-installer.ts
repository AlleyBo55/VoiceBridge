/**
 * Virtual microphone driver installer.
 * Handles platform-specific installation of the audio driver.
 */

import type { NativeAudioAddon } from '../native/native-addon.js';
import type { DriverStatus, DriverInstallResult } from '../shared/types.js';
import { getDriverType } from '../shared/platform.js';

// ── Driver Installer ────────────────────────────────────────

export class DriverInstaller {
  #nativeAddon: NativeAudioAddon;

  constructor(nativeAddon: NativeAudioAddon) {
    this.#nativeAddon = nativeAddon;
  }

  /** Check if the virtual mic driver is installed. */
  checkInstalled(): DriverStatus {
    return this.#nativeAddon.getDriverStatus();
  }

  /** Install the virtual mic driver. */
  async install(): Promise<DriverInstallResult> {
    const driverType = getDriverType();
    if (driverType === 'unsupported') {
      return { success: false, error: 'Unsupported platform' };
    }

    try {
      return this.#nativeAddon.installDriver();
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Installation failed',
      };
    }
  }

  /** Uninstall the virtual mic driver. */
  async uninstall(): Promise<boolean> {
    try {
      return this.#nativeAddon.uninstallDriver();
    } catch {
      return false;
    }
  }

  /** Check if bundled driver version is compatible. */
  checkVersionCompatibility(bundledVersion: string): boolean {
    const installed = this.#nativeAddon.getDriverVersion();
    if (!installed) return false;
    return installed === bundledVersion;
  }

  /** Verify the virtual mic device appears in OS device list. */
  verifyDevicePresent(): boolean {
    const devices = this.#nativeAddon.enumerateInputDevices();
    return devices.some(d => d.name === 'VoiceBridge Mic');
  }
}
