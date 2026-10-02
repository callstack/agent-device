import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isAppleProductType,
  isSupportedAppleDevicectlDevice,
  mapDevicectlAppleDevice,
  resolveAppleOs,
  resolveAppleTargetFromDevicectlDevice,
} from './inventory-classification.ts';

test('devicectl classification recognizes Apple families without relying on a device name', () => {
  assert.equal(isAppleProductType('iPhone16,2'), true);
  assert.equal(isAppleProductType('AppleTV11,1'), true);
  assert.equal(isAppleProductType('RealityDevice14,1'), true);
  assert.equal(isAppleProductType('Pixel 9'), false);
  assert.equal(
    isSupportedAppleDevicectlDevice({
      hardwareProperties: { productType: 'AppleTV11,1' },
      deviceProperties: { name: 'Living Room' },
    }),
    true,
  );
});

test('devicectl classification resolves tvOS, iPadOS, and visionOS vocabulary', () => {
  assert.equal(
    resolveAppleTargetFromDevicectlDevice({
      hardwareProperties: { platform: 'tvOS' },
    }),
    'tv',
  );
  assert.equal(resolveAppleOs('mobile', ['iPad16,3']), 'ipados');
  assert.equal(resolveAppleOs('mobile', ['visionOS 2.0']), 'visionos');
});

test('devicectl records map to normalized physical Apple devices', () => {
  assert.deepEqual(
    mapDevicectlAppleDevice({
      name: 'Living Room',
      hardwareProperties: {
        platform: 'tvOS',
        productType: 'AppleTV11,1',
        udid: 'tv-1',
      },
    }),
    {
      platform: 'apple',
      id: 'tv-1',
      name: 'Living Room',
      kind: 'device',
      target: 'tv',
      appleOs: 'tvos',
      iosPhysicalDeviceBackend: 'coredevice',
      booted: true,
    },
  );
  assert.equal(
    mapDevicectlAppleDevice({
      identifier: 'android-1',
      hardwareProperties: { platform: 'Android' },
    }),
    null,
  );
});

test('devicectl records report the marketing model and OS version', () => {
  const devicectlRecord = {
    identifier: '3F1DAD0D-212F-44F2-B41E-C390F96140BE',
    hardwareProperties: {
      deviceType: 'iPhone',
      marketingName: 'iPhone 17 Pro',
      platform: 'iOS',
      productType: 'iPhone18,1',
      udid: '00008150-000A1C2E3F40001E',
    },
    deviceProperties: {
      bootState: 'booted',
      name: 'Oskar iPhone',
      osBuildUpdate: '23F77',
      osVersionNumber: '26.5',
    },
    connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
  };
  const device = mapDevicectlAppleDevice(devicectlRecord);
  assert.equal(device?.name, 'Oskar iPhone');
  assert.equal(device?.model, 'iPhone 17 Pro');
  assert.equal(device?.osVersion, '26.5');
});
