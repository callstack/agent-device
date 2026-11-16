import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  serializeInstallFromSourceResult,
  serializeOpenResult,
  serializeSessionListEntry,
} from './result-serialization.ts';

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

// #4525: a CI integration records the OS a capture ran on from this result alone.
test('serializeOpenResult reports the device kind, model and OS version the host reported', () => {
  const ios = serializeOpenResult({
    session: 'ios',
    device: {
      platform: 'ios',
      target: 'mobile',
      id: 'SIM-001',
      name: 'iPhone 17',
      kind: 'simulator',
      model: 'iPhone 17',
      osVersion: '27.0',
      identifiers: { session: 'ios', deviceId: 'SIM-001', deviceName: 'iPhone 17' },
      ios: { udid: 'SIM-001' },
    },
    identifiers: { session: 'ios', deviceId: 'SIM-001', deviceName: 'iPhone 17' },
  });
  assert.deepEqual(
    {
      platform: ios.platform,
      device: ios.device,
      kind: ios.kind,
      model: ios.model,
      osVersion: ios.osVersion,
    },
    {
      platform: 'ios',
      device: 'iPhone 17',
      kind: 'simulator',
      model: 'iPhone 17',
      osVersion: '27.0',
    },
  );

  const android = serializeOpenResult({
    session: 'android',
    device: {
      platform: 'android',
      target: 'mobile',
      id: 'emulator-5554',
      name: 'pixel-9',
      kind: 'emulator',
      model: 'sdk_gphone64_arm64',
      osVersion: '16',
      identifiers: { session: 'android', deviceId: 'emulator-5554', serial: 'emulator-5554' },
      android: { serial: 'emulator-5554' },
    },
    identifiers: { session: 'android', deviceId: 'emulator-5554', serial: 'emulator-5554' },
  });
  assert.equal(android.kind, 'emulator');
  assert.equal(android.model, 'sdk_gphone64_arm64');
  assert.equal(android.osVersion, '16');
  assert.equal(android.serial, 'emulator-5554');

  // A rented cloud device keeps what its provider reported, on the same keys.
  const remote = serializeOpenResult({
    session: 'remote',
    device: {
      platform: 'ios',
      target: 'mobile',
      id: 'browserstack:ios:lease-1',
      name: 'iPhone 15',
      kind: 'device',
      osVersion: '17.2',
      identifiers: {
        session: 'remote',
        deviceId: 'browserstack:ios:lease-1',
        deviceName: 'iPhone 15',
      },
      ios: { udid: 'browserstack:ios:lease-1' },
    },
    identifiers: { session: 'remote', deviceId: 'browserstack:ios:lease-1' },
  });
  assert.equal(remote.kind, 'device');
  assert.equal(remote.osVersion, '17.2');
  // The provider reported no hardware model, so the field stays out rather than naming one.
  assert.equal('model' in remote, false);
});

test('serializeSessionListEntry reports the session device kind and OS version', () => {
  const data = serializeSessionListEntry({
    name: 'qa',
    createdAt: 123,
    device: {
      platform: 'ios',
      target: 'mobile',
      id: 'SIM-001',
      name: 'iPhone 17',
      kind: 'simulator',
      osVersion: '27.0',
      identifiers: { session: 'qa', deviceId: 'SIM-001', deviceName: 'iPhone 17' },
      ios: { udid: 'SIM-001' },
    },
    identifiers: { session: 'qa', deviceId: 'SIM-001', deviceName: 'iPhone 17' },
  });

  assert.equal(data.kind, 'simulator');
  assert.equal(data.osVersion, '27.0');
});

test('serializeOpenResult carries an answered launch confirmation', () => {
  const data = serializeOpenResult({
    session: 'qa',
    appBundleId: 'com.example.app',
    launchConfirmation: 'accepted',
    identifiers: { session: 'qa', appId: 'com.example.app', appBundleId: 'com.example.app' },
  });

  assert.equal(data.launchConfirmation, 'accepted');
});

test('serializeOpenResult carries an unanswered launch confirmation with its reason', () => {
  const data = serializeOpenResult({
    session: 'qa',
    appBundleId: 'com.example.app',
    launchConfirmation: 'unanswered',
    launchConfirmationReason: 'alert-unrecognized',
    identifiers: { session: 'qa', appId: 'com.example.app', appBundleId: 'com.example.app' },
  });

  assert.equal(data.launchConfirmation, 'unanswered');
  assert.equal(data.launchConfirmationReason, 'alert-unrecognized');
});

test('serializeOpenResult carries a probe-failure step without any confirmation outcome', () => {
  const data = serializeOpenResult({
    session: 'qa',
    appBundleId: 'com.example.app',
    launchConfirmationProbeFailure: 'runner',
    identifiers: { session: 'qa', appId: 'com.example.app', appBundleId: 'com.example.app' },
  });

  assert.equal(data.launchConfirmationProbeFailure, 'runner');
  assert.equal('launchConfirmation' in data, false);
  assert.equal('launchConfirmationReason' in data, false);
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
