import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('@agent-device/host-kit/command', () => ({
  runCmd: vi.fn(),
  runCmdSync: vi.fn(),
  whichCmd: vi.fn(async () => true),
}));
vi.mock('../../platforms/apple/core/simulator.ts', () => ({
  ensureBootedSimulator: vi.fn(async () => {}),
}));
vi.mock('../../platforms/android/emulator-lifecycle.ts', () => ({
  waitForAndroidBoot: vi.fn(async () => {}),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { waitForAndroidBoot } from '../../platforms/android/emulator-lifecycle.ts';
import { ensureBootedSimulator } from '../../platforms/apple/core/simulator.ts';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
} from '../../__tests__/test-utils/device-fixtures.ts';
import { DEVICE_READY_CACHE_TTL_MS, ensureDeviceReady } from '../device-ready.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);
const mockWaitForAndroidBoot = vi.mocked(waitForAndroidBoot);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));
  mockRunCmd.mockReset();
  mockEnsureBootedSimulator.mockReset();
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockWaitForAndroidBoot.mockReset();
  mockWaitForAndroidBoot.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

test('ensureDeviceReady caches successful simulator readiness checks', async () => {
  const device: DeviceInfo = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' };

  await ensureDeviceReady(device);
  await ensureDeviceReady({ ...device });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(1);
  expect(mockEnsureBootedSimulator).toHaveBeenCalledWith(
    device,
    expect.objectContaining({
      deviceHub: undefined,
      focusExisting: undefined,
    }),
  );
});

test('ensureDeviceReady focuses cached simulator readiness checks when requested', async () => {
  const device: DeviceInfo = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' };

  await ensureDeviceReady(device);
  await ensureDeviceReady({ ...device }, { deviceHub: true, focusExisting: true });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(2);
  expect(mockEnsureBootedSimulator).toHaveBeenLastCalledWith(
    { ...device },
    expect.objectContaining({ deviceHub: true, focusExisting: true }),
  );
});

test('ensureDeviceReady caches successful iOS physical device readiness checks', async () => {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    await fs.writeFile(
      jsonPath,
      JSON.stringify({
        result: {
          connectionProperties: {
            tunnelState: 'connected',
          },
        },
      }),
    );
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await ensureDeviceReady(IOS_DEVICE);
  await ensureDeviceReady({ ...IOS_DEVICE, simulatorSetPath: '/ignored-for-physical-device' });

  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

test('ensureDeviceReady includes simulator set path in the cache key', async () => {
  await ensureDeviceReady({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' });
  await ensureDeviceReady({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-b' });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady forwards iOS simulator cold boot callback', async () => {
  const onColdBootStart = vi.fn();
  await ensureDeviceReady(IOS_SIMULATOR, { onIosSimulatorColdBootStart: onColdBootStart });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledWith(
    IOS_SIMULATOR,
    expect.objectContaining({ onColdBootStart }),
  );
});

test('ensureDeviceReady expires cached readiness checks after the ttl', async () => {
  await ensureDeviceReady(ANDROID_EMULATOR);
  vi.setSystemTime(new Date(Date.now() + DEVICE_READY_CACHE_TTL_MS - 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR });
  vi.setSystemTime(new Date(Date.now() + 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR });

  expect(mockWaitForAndroidBoot).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady does not cache failed readiness checks', async () => {
  mockEnsureBootedSimulator.mockRejectedValueOnce(new Error('boot failed'));

  await expect(ensureDeviceReady(IOS_SIMULATOR)).rejects.toThrow('boot failed');
  await ensureDeviceReady(IOS_SIMULATOR);

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(2);
});
