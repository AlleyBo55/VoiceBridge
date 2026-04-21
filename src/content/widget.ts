/**
 * Widget module — extended widget functionality.
 * Separated from content-script for code organization.
 * Handles expanded state, roulette display, ghost mode visuals.
 */

export type WidgetMode = 'collapsed' | 'expanded' | 'roulette' | 'ghost';

/**
 * Format milliseconds as a latency display string.
 */
export function formatLatency(ms: number): string {
  return String(Math.round(ms));
}

/**
 * Get the latency status color class.
 */
export function getLatencyColor(ms: number): 'good' | 'moderate' | 'poor' {
  if (ms < 1500) return 'good';
  if (ms < 2500) return 'moderate';
  return 'poor';
}

/**
 * Format session duration from milliseconds.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Get the SVG icon markup for a widget state.
 */
export function getWidgetIcon(icon: string): string {
  switch (icon) {
    case 'microphone':
      return '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>';
    case 'globe':
      return '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>';
    case 'speaker':
      return '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
    case 'pause':
      return '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    case 'ghost':
      return '<path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2 2 3-3 3 3 2-2 3 3V10a8 8 0 0 0-8-8z"/>';
    case 'offline':
      return '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>';
    default:
      return '';
  }
}
