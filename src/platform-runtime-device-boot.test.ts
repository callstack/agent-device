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
  ANDROID_EMULATOR_GENERATION_BUDGET_MS: 10_000,
  inspectAndroidEmulatorGeneration: vi.fn(
    async (): Promise<{ identity: { pid: number; startTime: string } } | { miss: string }> => ({
      miss: 'no-listener',
    }),
  ),
  emitDiagnostic: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/simulator-boot', () => mocks);
vi.mock('@agent-device/platform-android/device-boot', () => mocks);
vi.mock('@agent-device/host-kit/diagnostics', () => ({ emitDiagnostic: mocks.emitDiagnostic }));

import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
} from '@agent-device/test-kit';
import { deviceBootObservation } from './platform-runtime-device-boot.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

test('generation is reported only when two serial observations agree', async () => {
  const identity = { pid: 42, startTime: 'start' };
  mocks.inspectAndroidEmulatorGeneration.mockResolvedValue({ identity });
  expect(await deviceBootObservation.assessShutdownGeneration(ANDROID_EMULATOR, identity)).toBe(
    'same',
  );
  // The two agreeing reads share one deadline, so a slow host cannot double the budget.
  const calls = mocks.inspectAndroidEmulatorGeneration.mock.calls as unknown as Array<
    [unknown, { deadline: unknown }]
  >;
  expect(calls[1]?.[1].deadline).toBe(calls[0]?.[1].deadline);
  mocks.inspectAndroidEmulatorGeneration
    .mockResolvedValueOnce({ identity })
    .mockResolvedValueOnce({ identity: { ...identity, startTime: 'replacement' } });
  expect(await deviceBootObservation.assessShutdownGeneration(ANDROID_EMULATOR, identity)).toBe(
    'unobserved',
  );
  mocks.inspectAndroidEmulatorGeneration.mockResolvedValue({
    identity: { pid: 43, startTime: 'replacement' },
  });
  expect(await deviceBootObservation.assessShutdownGeneration(ANDROID_EMULATOR, identity)).toBe(
    'changed',
  );
  expect(await deviceBootObservation.assessShutdownGeneration(LINUX_DEVICE, identity)).toBe(
    'not-applicable',
  );
  expect(
    await deviceBootObservation.assessShutdownGeneration(
      { ...ANDROID_EMULATOR, kind: 'device' },
      identity,
    ),
  ).toBe('not-applicable');
  expect(await deviceBootObservation.assessShutdownGeneration(ANDROID_EMULATOR, undefined)).toBe(
    'unobserved',
  );
});

test('an unverified close names the step and the read that missed', async () => {
  const identity = { pid: 42, startTime: 'start' };
  mocks.inspectAndroidEmulatorGeneration
    .mockResolvedValueOnce({ identity })
    .mockResolvedValueOnce({ miss: 'process-read-timeout' });
  expect(await deviceBootObservation.assessShutdownGeneration(ANDROID_EMULATOR, identity)).toBe(
    'unobserved',
  );
  await deviceBootObservation.assessShutdownGeneration(ANDROID_EMULATOR, undefined);
  const causes = mocks.emitDiagnostic.mock.calls
    .map(([event]) => event as { phase: string; data: { step: string; cause: string } })
    .filter((event) => event.phase === 'android_launch_identity_unobserved')
    .map((event) => `${event.data.step}:${event.data.cause}`);
  expect(causes).toEqual(['assess:second-process-read-timeout', 'assess:unbound-at-open']);
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
