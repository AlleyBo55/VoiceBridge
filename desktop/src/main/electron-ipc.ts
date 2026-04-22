/**
 * Typed Electron IPC router.
 * Replaces chrome.runtime.sendMessage with Electron's ipcMain/ipcRenderer.
 * Validates all incoming messages against the typed schema.
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import type {
  IPCMessage,
  MainToRendererEvents,
  RendererToMainInvocations,
  VALID_RENDERER_CHANNELS,
} from '../shared/types.js';

// ── IPC Message Validation ──────────────────────────────────

/**
 * Validate an IPC message envelope.
 * Checks channel, timestamp, and nonce fields.
 *
 * @param message - The raw message to validate
 * @param validChannels - Set of valid channel names
 * @returns Whether the message is well-formed
 */
export function validateIPCMessage(
  message: unknown,
  validChannels: ReadonlySet<string>
): message is IPCMessage {
  if (typeof message !== 'object' || message === null) return false;

  const msg = message as Record<string, unknown>;

  if (typeof msg['channel'] !== 'string') return false;
  if (!validChannels.has(msg['channel'])) return false;
  if (typeof msg['timestamp'] !== 'number') return false;
  if (typeof msg['nonce'] !== 'string') return false;

  return true;
}

// ── IPC Router ──────────────────────────────────────────────

type InvokeHandler<K extends keyof RendererToMainInvocations> =
  RendererToMainInvocations[K] extends [infer Params, infer Result]
    ? (params: Params) => Promise<Result> | Result
    : never;

/**
 * Register a typed IPC handler for renderer → main invocations.
 *
 * @param channel - The IPC channel name
 * @param handler - The handler function for the channel
 */
export function handleInvoke<K extends keyof RendererToMainInvocations>(
  channel: K,
  handler: InvokeHandler<K>
): void {
  ipcMain.handle(channel, async (_event, params: unknown) => {
    return handler(params as Parameters<InvokeHandler<K>>[0]);
  });
}

/**
 * Send a typed event from main process to renderer.
 *
 * @param window - The target BrowserWindow
 * @param channel - The event channel name
 * @param payload - The event payload
 */
export function sendToRenderer<K extends keyof MainToRendererEvents>(
  window: BrowserWindow | null,
  channel: K,
  payload: MainToRendererEvents[K]
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

/**
 * Create a unique nonce for IPC messages.
 */
export function createNonce(): string {
  return randomUUID();
}