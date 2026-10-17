import { promises as fs } from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmd: vi.fn(),
    runCmdSync: vi.fn(),
    whichCmd: vi.fn(async () => true),
  };
});
vi.mock('@agent-device/platform-apple/simulator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/simulator')>()),
  ensureBootedSimulator: vi.fn(async () => {}),
}));
vi.mock('@agent-device/platform-android/mechanics', () => ({
  waitForAndroidBoot: vi.fn(async () => {}),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { waitForAndroidBoot } from '@agent-device/platform-android/mechanics';
import { ensureBootedSimulator } from '@agent-device/platform-apple/simulator';
import { ANDROID_EMULATOR, IOS_DEVICE, IOS_SIMULATOR, LINUX_DEVICE } from '@agent-device/test-kit';
import { ensureLocalPlatformDeviceReady } from './platform-runtime-device-ready.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);
const mockWaitForAndroidBoot = vi.mocked(waitForAndroidBoot);

beforeEach(() => {
  mockRunCmd.mockReset();
  mockEnsureBootedSimulator.mockReset();
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockWaitForAndroidBoot.mockReset();
  mockWaitForAndroidBoot.mockResolvedValue(undefined);
});

test('an iOS simulator is readied by booting it through the Apple simulator leaf', async () => {
  const device = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' };

  await expect(ensureLocalPlatformDeviceReady(device)).resolves.toBe(true);

  expect(mockEnsureBootedSimulator).toHaveBeenCalledExactlyOnceWith(device);
});

test('a physical iOS device is readied by checking its connection tunnel', async () => {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    await fs.writeFile(
      jsonPath,
      JSON.stringify({ result: { connectionProperties: { tunnelState: 'connected' } } }),
    );
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await expect(ensureLocalPlatformDeviceReady(IOS_DEVICE)).resolves.toBe(true);

  expect(mockRunCmd).toHaveBeenCalledTimes(1);
  expect(mockEnsureBootedSimulator).not.toHaveBeenCalled();
});

test('an Android device is readied by waiting for boot completion', async () => {
  await expect(ensureLocalPlatformDeviceReady(ANDROID_EMULATOR)).resolves.toBe(true);

  expect(mockWaitForAndroidBoot).toHaveBeenCalledExactlyOnceWith(ANDROID_EMULATOR.id);
});

test('a platform without a readiness step reports it did not handle the device', async () => {
  await expect(ensureLocalPlatformDeviceReady(LINUX_DEVICE)).resolves.toBe(false);

  expect(mockEnsureBootedSimulator).not.toHaveBeenCalled();
  expect(mockWaitForAndroidBoot).not.toHaveBeenCalled();
  expect(mockRunCmd).not.toHaveBeenCalled();
});
