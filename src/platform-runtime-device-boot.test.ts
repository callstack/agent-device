import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';

const mocks = vi.hoisted(() => ({
  observeSimulatorBootTimeMs: vi.fn(async (): Promise<DeviceBootObservation> => ({
    observed: true,
    bootedAtMs: 1,
  })),
  observeAndroidBootTimeMs: vi.fn(async (): Promise<DeviceBootObservation> => ({
    observed: false,
    reason: 'unobserved',
  })),
}));

vi.mock('@agent-device/platform-apple/simulator-boot', () => mocks);
vi.mock('@agent-device/platform-android/device-boot', () => mocks);

import {
  ANDROID_EMULATOR,
  IPADOS_SIMULATOR,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
} from './__tests__/test-utils/device-fixtures.ts';
import { deviceBootObservation } from './platform-runtime-device-boot.ts';

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
