import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { ANDROID_EMULATOR, IOS_DEVICE, IOS_SIMULATOR } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { DEVICE_READY_CACHE_TTL_MS, ensureDeviceReady } from './device-ready.ts';

const ensureLocalDeviceReady = vi.fn(async (_device: DeviceInfo) => true);
const signal = new AbortController().signal;
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

  await ensureDeviceReady(device, platformServices, signal);
  await ensureDeviceReady({ ...device }, platformServices, signal);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(1);
  expect(ensureLocalDeviceReady).toHaveBeenCalledWith(device, signal);
});

test('ensureDeviceReady caches successful iOS physical device readiness checks', async () => {
  await ensureDeviceReady(IOS_DEVICE, platformServices, signal);
  await ensureDeviceReady(
    { ...IOS_DEVICE, simulatorSetPath: '/ignored-for-physical-device' },
    platformServices,
    signal,
  );

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(1);
});

test('ensureDeviceReady includes simulator set path in the cache key', async () => {
  await ensureDeviceReady(
    { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' },
    platformServices,
    signal,
  );
  await ensureDeviceReady(
    { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-b' },
    platformServices,
    signal,
  );

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady expires cached readiness checks after the ttl', async () => {
  await ensureDeviceReady(ANDROID_EMULATOR, platformServices, signal);
  vi.setSystemTime(new Date(Date.now() + DEVICE_READY_CACHE_TTL_MS - 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR }, platformServices, signal);
  vi.setSystemTime(new Date(Date.now() + 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR }, platformServices, signal);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady does not cache failed readiness checks', async () => {
  ensureLocalDeviceReady.mockRejectedValueOnce(new Error('boot failed'));

  await expect(ensureDeviceReady(IOS_SIMULATOR, platformServices, signal)).rejects.toThrow(
    'boot failed',
  );
  await ensureDeviceReady(IOS_SIMULATOR, platformServices, signal);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady does not cache a device the platform has no readiness step for', async () => {
  ensureLocalDeviceReady.mockResolvedValue(false);

  await ensureDeviceReady(ANDROID_EMULATOR, platformServices, signal);
  await ensureDeviceReady(ANDROID_EMULATOR, platformServices, signal);

  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});

test('an aborted request cannot use cached readiness', async () => {
  const device = { ...ANDROID_EMULATOR, id: 'readiness-cache-canceled' };
  await ensureDeviceReady(device, platformServices, signal);
  const canceled = new AbortController();
  const error = createRequestCanceledError();
  canceled.abort(error);

  await expect(ensureDeviceReady(device, platformServices, canceled.signal)).rejects.toBe(error);
  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(1);
});

test('readiness that settles after cancellation cannot publish a cache entry', async () => {
  const device = { ...ANDROID_EMULATOR, id: 'readiness-late-completion' };
  const canceled = new AbortController();
  const error = createRequestCanceledError();
  ensureLocalDeviceReady.mockImplementationOnce(async () => {
    canceled.abort(error);
    return true;
  });

  await expect(ensureDeviceReady(device, platformServices, canceled.signal)).rejects.toBe(error);
  await ensureDeviceReady(device, platformServices, signal);
  expect(ensureLocalDeviceReady).toHaveBeenCalledTimes(2);
});
