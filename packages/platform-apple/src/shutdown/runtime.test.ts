import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import { canShutdownTarget, createAppleShutdownRuntime } from './runtime.ts';

const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
const appleTools: DeviceShutdownRuntimeDependencies['appleTools'] = {
  isXcrunAvailable: async () => true,
  run,
};

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

test('an already-stopped simulator succeeds without native shutdown', async () => {
  const runtime = createAppleShutdownRuntime({ appleTools });

  await expect(runtime.shutdownTarget(appleDevice({ booted: false }), signal())).resolves.toEqual(
    success(),
  );
  expect(run).not.toHaveBeenCalled();
});

test('a shutdown error is successful when final simulator state is Shutdown', async () => {
  const device = appleDevice();
  run
    .mockResolvedValueOnce({
      stdout: '',
      stderr: 'Unable to shutdown device in current state: Shutdown',
      exitCode: 149,
    })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ devices: { ios: [{ udid: device.id, state: 'Shutdown' }] } }),
      stderr: '',
      exitCode: 0,
    });
  const runtime = createAppleShutdownRuntime({ appleTools });

  await expect(runtime.shutdownTarget(device, signal())).resolves.toEqual({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: 'Unable to shutdown device in current state: Shutdown',
  });
  expect(run).toHaveBeenNthCalledWith(
    1,
    { tool: 'simctl', args: ['shutdown', device.id], allowFailure: true, timeoutMs: 15_000 },
    expect.any(AbortSignal),
  );
});

test('cancellation during the final simulator-state probe is not swallowed', async () => {
  const device = appleDevice();
  const controller = new AbortController();
  run
    .mockResolvedValueOnce({
      stdout: '',
      stderr: 'shutdown failed',
      exitCode: 149,
    })
    .mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
  const runtime = createAppleShutdownRuntime({ appleTools });

  await expect(runtime.shutdownTarget(device, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(run).toHaveBeenCalledTimes(2);
});

test('watchOS and non-simulator Apple targets are unavailable', () => {
  expect(canShutdownTarget(appleDevice())).toBe(true);
  expect(canShutdownTarget(appleDevice({ appleOs: 'watchos' }))).toBe(false);
  expect(canShutdownTarget(appleDevice({ kind: 'device' }))).toBe(false);
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

function success() {
  return { success: true, exitCode: 0, stdout: '', stderr: '' };
}

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
    ...overrides,
  };
}
