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

test('devicectl classification resolves Apple OS vocabulary and excludes physical Watches', () => {
  assert.equal(
    resolveAppleTargetFromDevicectlDevice({
      hardwareProperties: { platform: 'tvOS' },
    }),
    'tv',
  );
  assert.equal(resolveAppleOs('mobile', ['iPad16,3']), 'ipados');
  assert.equal(resolveAppleOs('mobile', ['visionOS 2.0']), 'visionos');
  assert.equal(resolveAppleOs('mobile', ['iOS-26-0', 'Watch']), 'ios');
  assert.equal(
    resolveAppleOs('mobile', [
      'iOS-26-0',
      'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-46mm',
    ]),
    'watchos',
  );
  assert.equal(resolveAppleOs('mobile', ['iOS-26-0', 'Watch6,4']), 'ios');
  assert.equal(isAppleProductType('Watch6,4'), false);
  assert.equal(
    isSupportedAppleDevicectlDevice({
      hardwareProperties: { platform: 'iOS', productType: 'Watch6,4' },
    }),
    false,
  );
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
