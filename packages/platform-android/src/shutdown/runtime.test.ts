import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import { canShutdownTarget, createAndroidShutdownRuntime } from './runtime.ts';

const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
const commands: DeviceShutdownRuntimeDependencies['commands'] = {
  which: async () => 'adb',
  run,
};

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
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
