/**
 * Property 21: Platform mapping returns correct OS-specific values.
 * Feature: desktop-app-rewrite
 * Validates: Requirements 9.5, 9.10, 10.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getConfigDir, getDriverType, getKeyboardShortcut } from '../../src/shared/platform.js';

describe('Property 21: Platform mapping returns correct OS-specific values', () => {
  it('returns correct config directory per platform', () => {
    const platforms: Array<{ platform: NodeJS.Platform; contains: string }> = [
      { platform: 'darwin', contains: 'Library/Application Support/VoiceBridge' },
      { platform: 'win32', contains: 'VoiceBridge' },
      { platform: 'linux', contains: 'voicebridge' },
    ];

    for (const { platform, contains } of platforms) {
      const dir = getConfigDir(platform);
      expect(dir).toContain(contains);
    }
  });

  it('returns correct driver type per platform', () => {
    expect(getDriverType('darwin')).toBe('coreaudio');
    expect(getDriverType('win32')).toBe('wasapi');
    expect(getDriverType('linux')).toBe('pulseaudio');
    expect(getDriverType('freebsd' as NodeJS.Platform)).toBe('unsupported');
  });

  it('substitutes Cmd for Ctrl on darwin, preserves Ctrl elsewhere', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('darwin', 'win32', 'linux') as fc.Arbitrary<NodeJS.Platform>,
        fc.constantFrom(
          'CmdOrCtrl+Shift+T',
          'CmdOrCtrl+Shift+G',
          'CmdOrCtrl+Shift+X',
          'Ctrl+A',
        ),
        (platform, shortcut) => {
          const result = getKeyboardShortcut(shortcut, platform);
          if (platform === 'darwin') {
            expect(result).not.toContain('Ctrl');
            expect(result).not.toContain('CmdOrCtrl');
            if (shortcut.includes('CmdOrCtrl') || shortcut.includes('Ctrl')) {
              expect(result).toContain('Cmd');
            }
          } else {
            expect(result).not.toContain('Cmd');
            expect(result).not.toContain('CmdOrCtrl');
            if (shortcut.includes('CmdOrCtrl') || shortcut.includes('Ctrl')) {
              expect(result).toContain('Ctrl');
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
