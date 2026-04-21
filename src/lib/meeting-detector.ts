/**
 * Meeting platform detection and audio injection strategy selection.
 * Identifies the active meeting platform from the current tab URL.
 */

import type { MeetingPlatform, AudioInjectionStrategy } from './types.js';

// ── Platform URL Patterns ───────────────────────────────────

const PLATFORM_PATTERNS: Record<Exclude<MeetingPlatform, 'generic' | 'none'>, RegExp> = {
  'google-meet': /^https:\/\/meet\.google\.com\/.+/,
  'zoom': /^https:\/\/[\w.]*zoom\.us\/wc\/.+/,
  'teams': /^https:\/\/teams\.microsoft\.com\/.+/,
  'discord': /^https:\/\/discord\.com\/channels\/.+/,
};

// ── Detection ───────────────────────────────────────────────

/**
 * Detect the meeting platform from a URL.
 * Returns exactly one match, or 'none' if no platform is detected.
 */
export function detectPlatform(url: string): MeetingPlatform {
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    if (pattern.test(url)) {
      return platform as MeetingPlatform;
    }
  }
  return 'none';
}

/**
 * Get the audio injection strategy for a given platform.
 */
export function getInjectionStrategy(platform: MeetingPlatform): AudioInjectionStrategy {
  switch (platform) {
    case 'google-meet':
      return { type: 'getUserMedia-intercept' };
    case 'zoom':
      return { type: 'tabCapture-mix' };
    case 'teams':
    case 'discord':
    case 'generic':
      return { type: 'replaceTrack' };
    case 'none':
      return { type: 'none' };
  }
}

/**
 * Get a human-readable platform name.
 */
export function getPlatformName(platform: MeetingPlatform): string {
  switch (platform) {
    case 'google-meet': return 'Google Meet';
    case 'zoom': return 'Zoom';
    case 'teams': return 'Microsoft Teams';
    case 'discord': return 'Discord';
    case 'generic': return 'WebRTC App';
    case 'none': return 'No Meeting';
  }
}
