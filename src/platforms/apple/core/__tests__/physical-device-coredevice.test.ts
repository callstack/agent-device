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
