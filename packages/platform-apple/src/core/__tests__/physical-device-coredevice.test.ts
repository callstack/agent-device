import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  parseIosDeviceDetailsPayload,
  resolveIosReadyHint,
} from '../physical-device-coredevice.ts';

/**
 * `xcrun devicectl device info details` is the one tool that answers what a device thinks of itself,
 * and #2682 read its output for exactly one of those answers. The capture below is the shape that
 * made the mistake possible: the toggle and the developer disk image sit side by side in
 * `deviceProperties`, so a reader that only looks for one of them reports the other wrongly.
 */
const DEVICE_INFO_DETAILS_CAPTURE = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'ios-device-info-details.json'),
    'utf8',
  ),
) as unknown;

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

test('parseIosDeviceDetailsPayload reads the developer mode toggle and the disk image apart', () => {
  // The capture is a device that is fine on both counts. Reading them apart is the point: a reader
  // that returns one boolean for both cannot tell "toggle off" from "Xcode has not finished".
  const captured = parseIosDeviceDetailsPayload(DEVICE_INFO_DETAILS_CAPTURE);
  assert.equal(captured.developerModeStatus, 'enabled');
  assert.equal(captured.developerDiskImageServicesAvailable, true);
  assert.equal(captured.outcome, 'success');

  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { deviceProperties: { developerModeStatus: 'disabled', ddiServicesAvailable: true } },
    }),
    { developerModeStatus: 'disabled', developerDiskImageServicesAvailable: true },
  );
  // The nested shape a `devicectl device list`-style envelope wraps the device in.
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: {
        device: {
          deviceProperties: { developerModeStatus: 'enabled', ddiServicesAvailable: false },
        },
      },
    }),
    { developerModeStatus: 'enabled', developerDiskImageServicesAvailable: false },
  );
  // `false` is a read answer and has to survive; an absent key must not become `false`.
  assert.equal(
    parseIosDeviceDetailsPayload({ result: { deviceProperties: { ddiServicesAvailable: false } } })
      .developerDiskImageServicesAvailable,
    false,
  );
  assert.equal(
    'developerDiskImageServicesAvailable' in
      parseIosDeviceDetailsPayload({ result: { deviceProperties: {} } }),
    false,
  );
});

test('parseIosDeviceDetailsPayload reads one field per fact and not the display mirror', () => {
  // `result.properties.state` mirrors the toggle in a structured form the tool renders for humans.
  // Reading it too would give two sources for one fact, so the mirror stays unread and a payload
  // that carries only the mirror reports nothing (#2683).
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { properties: { state: { developerModeStatus: { enabled: { mode: 1 } } } } },
    }),
    {},
  );
});

test('parseIosDeviceDetailsPayload ignores malformed device states', () => {
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { deviceProperties: { developerModeStatus: {}, ddiServicesAvailable: 'true' } },
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
