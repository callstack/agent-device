import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import { canShutdownTarget, createAndroidShutdownRuntime } from './runtime.ts';

const sleep = vi.hoisted(() => vi.fn(async (_ms: number, _signal?: AbortSignal) => {}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep,
}));

import { testImeLastRestoreAtMs } from '../ime-state.ts';

const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
const commands: DeviceShutdownRuntimeDependencies['commands'] = {
  which: async () => 'adb',
  run,
};

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  sleep.mockClear();
  testImeLastRestoreAtMs.clear();
});

test('an already-stopped emulator succeeds without adb', async () => {
  const runtime = createAndroidShutdownRuntime({ commands });

  await expect(runtime.shutdownTarget(androidDevice({ booted: false }), signal())).resolves.toEqual(
    success(),
  );
  expect(run).not.toHaveBeenCalled();
});

test('an active emulator shuts down through the owning adb command', async () => {
  const device = androidDevice();
  const runtime = createAndroidShutdownRuntime({ commands });

  await expect(runtime.shutdownTarget(device, signal())).resolves.toEqual(success());
  expect(run).toHaveBeenCalledWith(
    {
      executable: 'adb',
      args: ['-s', device.id, 'emu', 'kill'],
      allowFailure: true,
      timeoutMs: 15_000,
    },
    expect.any(AbortSignal),
  );
});

test('only Android emulators are available', () => {
  expect(canShutdownTarget(androidDevice())).toBe(true);
  expect(canShutdownTarget({ ...androidDevice(), kind: 'device' })).toBe(false);
  expect(canShutdownTarget({ ...androidDevice(), platform: 'web' })).toBe(false);
});

// #3318: this runtime is the only executor of `adb emu kill`, so the flush-window hold lives
// here — every kill path (close --shutdown, the standalone shutdown command, any future
// caller) inherits it without knowing about the test IME.
test('a kill waits out a registered test-IME flush window before running adb emu kill', async () => {
  const device = androidDevice();
  testImeLastRestoreAtMs.set(device.id, performance.now());

  await expect(
    createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal()),
  ).resolves.toEqual(success());

  expect(sleep).toHaveBeenCalledTimes(1);
  // The wait must cover the registered window, not merely be positive: the timestamp was set
  // milliseconds before the kill, so the remaining settle is the whole ~2.5 s budget minus that
  // gap. A regression sleeping a fixed unrelated amount would fail here.
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(2_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect([...testImeLastRestoreAtMs.keys()]).toEqual([]);
});

test('a forward host wall-clock jump cannot shorten a registered flush window', async () => {
  // The window is timed on the process monotonic clock, so an NTP/VM-resume step of the wall
  // clock must leave the kill-side remaining wait at the full budget.
  const device = androidDevice();
  testImeLastRestoreAtMs.set(device.id, performance.now());
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);

  try {
    await expect(
      createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal()),
    ).resolves.toEqual(success());
  } finally {
    nowSpy.mockRestore();
  }

  expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(2_000);
});

test('a kill skips the wait entirely when no flush window is open', async () => {
  const device = androidDevice();

  await expect(
    createAndroidShutdownRuntime({ commands }).shutdownTarget(device, signal()),
  ).resolves.toEqual(success());

  expect(sleep).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(1);
});

test('a kill cancelled inside the flush window never reaches adb emu kill', async () => {
  const device = androidDevice();
  testImeLastRestoreAtMs.set(device.id, performance.now());
  const controller = new AbortController();
  sleep.mockImplementationOnce((_ms, waitSignal) => {
    controller.abort();
    return waitSignal?.aborted ? Promise.resolve() : new Promise(() => {});
  });

  await expect(
    createAndroidShutdownRuntime({ commands }).shutdownTarget(device, controller.signal),
  ).rejects.toBeDefined();

  expect(run).not.toHaveBeenCalled();
  // The window stays registered so a retry still waits out the remainder.
  expect([...testImeLastRestoreAtMs.keys()]).toEqual([device.id]);
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

function success() {
  return { success: true, exitCode: 0, stdout: '', stderr: '' };
}

function androidDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
    ...overrides,
  };
}
