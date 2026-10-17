import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { ANDROID_EMULATOR, IOS_DEVICE, IOS_SIMULATOR } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { DEVICE_READY_CACHE_TTL_MS, ensureDeviceReady } from './device-ready.ts';

const ensureLocalDeviceReady = vi.fn(async (_device: DeviceInfo) => true);
const platformServices = daemonPlatformServicesFixture({ ensureLocalDeviceReady });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));
  ensureLocalDeviceReady.mockReset();
  ensureLocalDeviceReady.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

test('ensureDeviceReady caches successful simulator readiness checks', async () => {
  const device: DeviceInfo = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' };

  await ensureDeviceReady(device, platformServices);
  await ensureDeviceReady({ ...device }, platformServices);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(1);
  expect(ensureLocalDeviceReady).toHaveBeenCalledWith(device);
});

test('ensureDeviceReady caches successful iOS physical device readiness checks', async () => {
  await ensureDeviceReady(IOS_DEVICE, platformServices);
  await ensureDeviceReady(
    { ...IOS_DEVICE, simulatorSetPath: '/ignored-for-physical-device' },
    platformServices,
  );

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(1);
});

test('ensureDeviceReady includes simulator set path in the cache key', async () => {
  await ensureDeviceReady(
    { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' },
    platformServices,
  );
  await ensureDeviceReady(
    { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-b' },
    platformServices,
  );

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady expires cached readiness checks after the ttl', async () => {
  await ensureDeviceReady(ANDROID_EMULATOR, platformServices);
  vi.setSystemTime(new Date(Date.now() + DEVICE_READY_CACHE_TTL_MS - 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR }, platformServices);
  vi.setSystemTime(new Date(Date.now() + 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR }, platformServices);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady does not cache failed readiness checks', async () => {
  ensureLocalDeviceReady.mockRejectedValueOnce(new Error('boot failed'));

  await expect(ensureDeviceReady(IOS_SIMULATOR, platformServices)).rejects.toThrow('boot failed');
  await ensureDeviceReady(IOS_SIMULATOR, platformServices);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady does not cache a device the platform has no readiness step for', async () => {
  ensureLocalDeviceReady.mockResolvedValue(false);

  await ensureDeviceReady(ANDROID_EMULATOR, platformServices);
  await ensureDeviceReady(ANDROID_EMULATOR, platformServices);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});
