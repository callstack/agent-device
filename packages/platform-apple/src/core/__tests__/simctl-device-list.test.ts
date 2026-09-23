import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readSimctlDevicesByRuntime, readSimctlDeviceState } from '../simctl-device-list.ts';

const LISTING = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      { udid: 'sim-a', state: 'Shutdown', name: 'iPhone 16' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'sim-b', state: 'Booted', name: 'iPhone 17' },
    ],
  },
});

test('readSimctlDeviceState reports the listed state of the requested simulator', () => {
  assert.equal(readSimctlDeviceState(LISTING, 'sim-b'), 'Booted');
  assert.equal(readSimctlDeviceState(LISTING, 'sim-a'), 'Shutdown');
});

test('readSimctlDeviceState is null for an unlisted, unreadable, or empty listing', () => {
  assert.equal(readSimctlDeviceState(LISTING, 'sim-missing'), null);
  assert.equal(readSimctlDeviceState('not json', 'sim-b'), null);
  assert.equal(readSimctlDeviceState('{}', 'sim-b'), null);
  assert.equal(readSimctlDeviceState(JSON.stringify({ devices: { runtime: {} } }), 'sim-b'), null);
});

test('readSimctlDevicesByRuntime keys each device list by its runtime', () => {
  const devicesByRuntime = readSimctlDevicesByRuntime(LISTING);
  assert.deepEqual(
    Object.entries(devicesByRuntime).map(([runtime, devices]) => [
      runtime,
      devices.map(({ udid }) => udid),
    ]),
    [
      ['com.apple.CoreSimulator.SimRuntime.iOS-18-0', ['sim-a']],
      ['com.apple.CoreSimulator.SimRuntime.iOS-26-0', ['sim-b']],
    ],
  );
  assert.deepEqual(readSimctlDevicesByRuntime('{}'), {});
  assert.throws(() => readSimctlDevicesByRuntime('not json'), SyntaxError);
});
