import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveDeployResultTarget,
  resolveInstallFromSourceResultTarget,
  serializeInstallFromSourceResult,
  serializeOpenResult,
  serializeSessionListEntry,
} from '../result-serialization.ts';

test('resolveDeployResultTarget follows the public app target precedence', () => {
  assert.equal(
    resolveDeployResultTarget({ app: 'fallback', bundleId: 'com.example.app', package: 'example' }),
    'com.example.app',
  );
  assert.equal(resolveDeployResultTarget({ app: 'fallback', package: 'example' }), 'example');
  assert.equal(resolveDeployResultTarget({ app: 'fallback' }), 'fallback');
});

test('resolveInstallFromSourceResultTarget follows the public install target precedence', () => {
  assert.equal(
    resolveInstallFromSourceResultTarget({
      launchTarget: 'com.example.app',
      appName: 'Demo',
      bundleId: 'com.example.bundle',
      packageName: 'com.example.package',
    }),
    'Demo',
  );
  assert.equal(
    resolveInstallFromSourceResultTarget({
      launchTarget: 'com.example.app',
      packageName: 'com.example.package',
    }),
    'com.example.package',
  );
});

test('serializeSessionListEntry preserves legacy android session payload shape', () => {
  const data = serializeSessionListEntry({
    name: 'qa',
    createdAt: 123,
    device: {
      platform: 'android',
      target: 'mobile',
      id: 'emulator-5554',
      name: 'Pixel 9',
      identifiers: {
        session: 'qa',
        deviceId: 'emulator-5554',
        deviceName: 'Pixel 9',
        serial: 'emulator-5554',
      },
      android: {
        serial: 'emulator-5554',
      },
    },
    identifiers: {
      session: 'qa',
      deviceId: 'emulator-5554',
      deviceName: 'Pixel 9',
      serial: 'emulator-5554',
    },
  });

  assert.deepEqual(data, {
    name: 'qa',
    platform: 'android',
    target: 'mobile',
    device: 'Pixel 9',
    id: 'emulator-5554',
    createdAt: 123,
  });
});

test('serializeOpenResult includes android serial for open payloads', () => {
  const data = serializeOpenResult({
    session: 'qa',
    device: {
      platform: 'android',
      target: 'mobile',
      id: 'emulator-5554',
      name: 'Pixel 9',
      identifiers: {
        session: 'qa',
        deviceId: 'emulator-5554',
        deviceName: 'Pixel 9',
        serial: 'emulator-5554',
      },
      android: {
        serial: 'emulator-5554',
      },
    },
    identifiers: {
      session: 'qa',
      deviceId: 'emulator-5554',
      deviceName: 'Pixel 9',
      serial: 'emulator-5554',
    },
  });

  assert.deepEqual(data, {
    session: 'qa',
    platform: 'android',
    target: 'mobile',
    device: 'Pixel 9',
    id: 'emulator-5554',
    serial: 'emulator-5554',
    message: 'Opened: qa',
  });
});

test('serializeInstallFromSourceResult uses install-family package naming', () => {
  const data = serializeInstallFromSourceResult({
    launchTarget: 'com.example.demo',
    appName: 'Demo',
    appId: 'com.example.demo',
    packageName: 'com.example.demo',
    identifiers: {
      appId: 'com.example.demo',
      package: 'com.example.demo',
    },
  });

  assert.deepEqual(data, {
    launchTarget: 'com.example.demo',
    appName: 'Demo',
    appId: 'com.example.demo',
    package: 'com.example.demo',
    message: 'Installed: Demo',
  });
});
