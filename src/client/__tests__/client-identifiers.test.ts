import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildAppIdentifiers, buildDeviceIdentifiers } from '../client-identifiers.ts';

test('buildAppIdentifiers preserves explicit and platform app identifiers', () => {
  assert.deepEqual(
    buildAppIdentifiers({
      session: 'qa',
      bundleId: 'com.example.app',
      packageName: 'com.example.app',
      appId: 'explicit',
    }),
    {
      session: 'qa',
      appId: 'explicit',
      appBundleId: 'com.example.app',
      package: 'com.example.app',
    },
  );
  assert.deepEqual(buildAppIdentifiers({ packageName: 'com.example.app' }), {
    session: undefined,
    appId: 'com.example.app',
    appBundleId: undefined,
    package: 'com.example.app',
  });
});

test('buildDeviceIdentifiers maps platform address identifiers', () => {
  assert.deepEqual(buildDeviceIdentifiers('ios', 'sim-1', 'iPhone'), {
    deviceId: 'sim-1',
    deviceName: 'iPhone',
    udid: 'sim-1',
  });
  assert.deepEqual(buildDeviceIdentifiers('android', 'emulator-5554', 'Pixel 9'), {
    deviceId: 'emulator-5554',
    deviceName: 'Pixel 9',
    serial: 'emulator-5554',
  });
});
