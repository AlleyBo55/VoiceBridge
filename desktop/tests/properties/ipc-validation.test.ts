/**
 * Property 17: IPC message validation accepts well-formed and rejects malformed messages.
 * Feature: desktop-app-rewrite
 * Validates: Requirements 10.10
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateIPCMessage } from '../../src/main/electron-ipc.js';
import { VALID_RENDERER_CHANNELS, VALID_MAIN_CHANNELS } from '../../src/shared/types.js';

describe('Property 17: IPC message validation', () => {
  const allChannels = new Set([...VALID_RENDERER_CHANNELS, ...VALID_MAIN_CHANNELS]);

  it('accepts well-formed messages with valid channels', () => {
    const channelArb = fc.constantFrom(...allChannels);

    fc.assert(
      fc.property(
        channelArb,
        fc.anything(),
        fc.nat(),
        fc.uuid(),
        (channel, payload, timestamp, nonce) => {
          const msg = { channel, payload, timestamp, nonce };
          expect(validateIPCMessage(msg, allChannels)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects messages with invalid channel', () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => !allChannels.has(s)),
        fc.anything(),
        fc.nat(),
        fc.uuid(),
        (channel, payload, timestamp, nonce) => {
          const msg = { channel, payload, timestamp, nonce };
          expect(validateIPCMessage(msg, allChannels)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects messages missing required fields', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allChannels),
        fc.constantFrom('channel', 'timestamp', 'nonce'),
        (channel, missingField) => {
          const msg: Record<string, unknown> = {
            channel,
            payload: {},
            timestamp: Date.now(),
            nonce: 'test-nonce',
          };
          delete msg[missingField];
          expect(validateIPCMessage(msg, allChannels)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects non-object values', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (value) => {
          expect(validateIPCMessage(value, allChannels)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects messages with wrong field types', () => {
    const channelArb = fc.constantFrom(...allChannels);

    fc.assert(
      fc.property(channelArb, (channel) => {
        // timestamp is string instead of number
        expect(validateIPCMessage({ channel, payload: {}, timestamp: 'not-a-number', nonce: 'x' }, allChannels)).toBe(false);
        // nonce is number instead of string
        expect(validateIPCMessage({ channel, payload: {}, timestamp: 123, nonce: 123 }, allChannels)).toBe(false);
        // channel is number instead of string
        expect(validateIPCMessage({ channel: 123, payload: {}, timestamp: 123, nonce: 'x' }, allChannels)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
