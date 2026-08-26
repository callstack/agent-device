import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseIosDeviceDetailsPayload,
  resolveIosReadyHint,
} from '../physical-device-coredevice.ts';

test('parseIosDeviceDetailsPayload reads direct and nested tunnel state', () => {
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: { connectionProperties: { tunnelState: 'connected' } },
    }).tunnelState,
    'connected',
  );
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: { device: { connectionProperties: { tunnelState: 'connecting' } } },
    }).tunnelState,
    'connecting',
  );
});

test('parseIosDeviceDetailsPayload reads direct and nested tunnel ip plus the info outcome', () => {
  // The runner's usbmux-unattached fallback resolves the tunnel ip through this
  // parser; the moved runner transport tests fake the control seam, so the real
  // devicectl payload shapes are pinned here instead.
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      info: { outcome: 'success' },
      result: { connectionProperties: { tunnelIPAddress: 'fdda::2', tunnelState: 'connected' } },
    }),
    { outcome: 'success', tunnelState: 'connected', tunnelIp: 'fdda::2' },
  );
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: { device: { connectionProperties: { tunnelIPAddress: 'fdda::3' } } },
    }).tunnelIp,
    'fdda::3',
  );
  // The direct shape wins over the nested fallback when both are present.
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: {
        connectionProperties: { tunnelIPAddress: 'fdda::2' },
        device: { connectionProperties: { tunnelIPAddress: 'fdda::9' } },
      },
    }).tunnelIp,
    'fdda::2',
  );
  assert.equal(
    parseIosDeviceDetailsPayload({ info: { outcome: 'failure' }, result: {} }).outcome,
    'failure',
  );
});

test('parseIosDeviceDetailsPayload ignores malformed values', () => {
  assert.deepEqual(parseIosDeviceDetailsPayload(null), {});
  assert.deepEqual(parseIosDeviceDetailsPayload({}), {});
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { connectionProperties: { tunnelState: 123 } },
    }),
    {},
  );
});

test('resolveIosReadyHint maps known connection errors', () => {
  assert.match(
    resolveIosReadyHint('', 'Device is busy (Connecting to iPhone)'),
    /still connecting/i,
  );
  assert.match(resolveIosReadyHint('CoreDeviceService timed out', ''), /coredevice service/i);
});

test('resolveIosReadyHint falls back to generic guidance', () => {
  const hint = resolveIosReadyHint('unexpected failure', '');
  assert.match(hint, /unlocked/i);
  assert.match(hint, /xcode/i);
});
