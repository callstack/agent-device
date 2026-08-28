import { expect, test } from 'vitest';
import {
  buildDoublespeedDevice,
  isDoublespeedLeaseBackend,
  isSupportedDoublespeedDevice,
  parseDoublespeedDeviceId,
} from './device.ts';
import { doublespeedIosDevice, doublespeedLease } from './runtime.fixtures.ts';

test('builds and parses the provider-owned device identity', () => {
  const device = buildDoublespeedDevice(doublespeedLease(), {
    id: 'sim-abcdef0123',
    device: 'iPhone 16',
  });
  expect(device).toEqual({
    platform: 'apple',
    appleOs: 'ios',
    id: 'doublespeed:ios:lease-a',
    name: 'Doublespeed iPhone 16 sim-abcd',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  });
  expect(parseDoublespeedDeviceId(device.id)).toEqual({ leaseId: 'lease-a' });
  expect(parseDoublespeedDeviceId('limrun:ios:lease-a')).toBeUndefined();
  expect(parseDoublespeedDeviceId('doublespeed:android:lease-a')).toBeUndefined();
  expect(parseDoublespeedDeviceId('doublespeed:ios:')).toBeUndefined();
});

test('supports exactly the mobile iOS simulator leaf carrying its own id', () => {
  expect(isSupportedDoublespeedDevice(doublespeedIosDevice)).toBe(true);
  expect(isSupportedDoublespeedDevice({ ...doublespeedIosDevice, kind: 'device' })).toBe(false);
  expect(
    isSupportedDoublespeedDevice({ ...doublespeedIosDevice, appleOs: 'tvos', target: 'tv' }),
  ).toBe(false);
  expect(isSupportedDoublespeedDevice({ ...doublespeedIosDevice, target: 'tv' })).toBe(false);
  expect(isSupportedDoublespeedDevice({ ...doublespeedIosDevice, id: 'limrun:ios:lease-a' })).toBe(
    false,
  );
  expect(
    isSupportedDoublespeedDevice({ ...doublespeedIosDevice, iosPhysicalDeviceBackend: 'xctest' }),
  ).toBe(false);
});

test('owns the iOS instance lease backend only', () => {
  expect(isDoublespeedLeaseBackend('ios-instance')).toBe(true);
  expect(isDoublespeedLeaseBackend('android-instance')).toBe(false);
  expect(isDoublespeedLeaseBackend('simulator')).toBe(false);
});
