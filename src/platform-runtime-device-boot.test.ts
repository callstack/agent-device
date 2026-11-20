import { beforeEach, expect, test, vi } from 'vitest';
import type {
  DeviceBootObservation,
  LaunchedProcessCheck,
  LaunchedProcessStopConfirmation,
} from '@agent-device/contracts/device-boot';

const mocks = vi.hoisted(() => ({
  observeSimulatorBootTimeMs: vi.fn(async (): Promise<DeviceBootObservation> => ({
    observed: true,
    bootedAtMs: 1,
  })),
  observeAndroidBootTimeMs: vi.fn(async (): Promise<DeviceBootObservation> => ({
    observed: false,
    reason: 'unobserved',
  })),
  checkAndroidEmulatorLaunchProcess: vi.fn(
    async (): Promise<LaunchedProcessCheck> => 'changed' satisfies LaunchedProcessCheck,
  ),
  confirmAndroidEmulatorLaunchProcessStopped: vi.fn(
    async (): Promise<LaunchedProcessStopConfirmation> => 'unconfirmed',
  ),
}));

vi.mock('@agent-device/platform-apple/simulator-boot', () => mocks);
vi.mock('@agent-device/platform-android/device-boot', () => mocks);

import {
  ANDROID_DEVICE,
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
} from '@agent-device/test-kit';
import { deviceBootObservation, launchedDeviceProcess } from './platform-runtime-device-boot.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

test('an iOS Simulator is answered by the Apple probe alone', async () => {
  expect(await deviceBootObservation.observeBootTimeMs(IOS_SIMULATOR)).toEqual({
    observed: true,
    bootedAtMs: 1,
  });
  expect(mocks.observeSimulatorBootTimeMs).toHaveBeenCalledWith(IOS_SIMULATOR);
  expect(mocks.observeAndroidBootTimeMs).not.toHaveBeenCalled();
});

test('every Simulator of the Apple touch family shares the CoreSimulator boot probe', async () => {
  for (const device of [IPADOS_SIMULATOR, TVOS_SIMULATOR, VISIONOS_SIMULATOR]) {
    expect(await deviceBootObservation.observeBootTimeMs(device)).toEqual({
      observed: true,
      bootedAtMs: 1,
    });
  }
  expect(mocks.observeAndroidBootTimeMs).not.toHaveBeenCalled();
});

test('an Android device is answered by the Android probe alone', async () => {
  expect(await deviceBootObservation.observeBootTimeMs(ANDROID_EMULATOR)).toEqual({
    observed: false,
    reason: 'unobserved',
  });
  expect(mocks.observeAndroidBootTimeMs).toHaveBeenCalledWith(ANDROID_EMULATOR);
  expect(mocks.observeSimulatorBootTimeMs).not.toHaveBeenCalled();
});

test('a device whose family asks no boot question is refused without loading a probe', async () => {
  for (const device of [MACOS_DEVICE, LINUX_DEVICE]) {
    expect(await deviceBootObservation.observeBootTimeMs(device)).toEqual({
      observed: false,
      reason: 'unsupported-device',
    });
  }
  expect(mocks.observeSimulatorBootTimeMs).not.toHaveBeenCalled();
  expect(mocks.observeAndroidBootTimeMs).not.toHaveBeenCalled();
});

const LAUNCH_IDENTITY = { pid: 4112, startTime: 'launch-start-time' } as const;

test('an Android emulator is the only device whose launch has a process to check', async () => {
  // The answer is passed through as the Android owner gave it, so the composition adds no verdict.
  expect(await launchedDeviceProcess.checkLaunchedProcess(ANDROID_EMULATOR, LAUNCH_IDENTITY)).toBe(
    'changed',
  );
  expect(mocks.checkAndroidEmulatorLaunchProcess).toHaveBeenCalledWith(LAUNCH_IDENTITY);

  await launchedDeviceProcess.confirmLaunchedProcessStopped(ANDROID_EMULATOR, LAUNCH_IDENTITY);
  expect(mocks.confirmAndroidEmulatorLaunchProcessStopped).toHaveBeenCalledWith(LAUNCH_IDENTITY);
});

test('a device with no host launch process is answered without loading a probe', async () => {
  for (const device of [IOS_SIMULATOR, ANDROID_DEVICE, MACOS_DEVICE]) {
    expect(await launchedDeviceProcess.checkLaunchedProcess(device, LAUNCH_IDENTITY)).toBe(
      'not-applicable',
    );
    expect(await launchedDeviceProcess.confirmLaunchedProcessStopped(device, LAUNCH_IDENTITY)).toBe(
      'stopped',
    );
  }
  expect(mocks.checkAndroidEmulatorLaunchProcess).not.toHaveBeenCalled();
  expect(mocks.confirmAndroidEmulatorLaunchProcessStopped).not.toHaveBeenCalled();
});

test('an Android launch that recorded no process is refused before the process is read', async () => {
  expect(await launchedDeviceProcess.checkLaunchedProcess(ANDROID_EMULATOR, undefined)).toBe(
    'unverified',
  );
  expect(mocks.checkAndroidEmulatorLaunchProcess).not.toHaveBeenCalled();
});
