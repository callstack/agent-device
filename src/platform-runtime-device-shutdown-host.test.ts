import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDeviceShutdownRuntimeHost } from './platform-runtime-device-shutdown-host.ts';

const appleShutdown = vi.fn(async () => success());
const androidShutdown = vi.fn(async () => success());
const shutdownLoaders = {
  apple: vi.fn(async () => ({
    canShutdownTarget: () => true,
    shutdownTarget: appleShutdown,
  })),
  android: vi.fn(async () => ({
    canShutdownTarget: () => true,
    shutdownTarget: androidShutdown,
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  appleShutdown.mockResolvedValue(success());
  androidShutdown.mockResolvedValue(success());
});

test('canonical shutdown and close share one cached owner runtime', async () => {
  const device = appleDevice({ booted: false });
  const host = shutdownHost();

  await expect(host.apple.shutdownTarget(device, signal())).resolves.toEqual(success());
  await expect(host.close?.shutdownTarget(device)).resolves.toEqual(success());
  expect(await host.close?.canShutdownTarget(device)).toBe(true);
  expect(appleShutdown).toHaveBeenCalledTimes(2);
  expect(shutdownLoaders.apple).toHaveBeenCalledOnce();
  expect(shutdownLoaders.android).not.toHaveBeenCalled();
});

test('canonical Apple shutdown and close use one cached owner runtime', async () => {
  const device = appleDevice();
  const host = shutdownHost();

  await expect(host.apple.shutdownTarget(device, signal())).resolves.toEqual(success());
  await expect(host.close?.shutdownTarget(device)).resolves.toEqual(success());
  expect(shutdownLoaders.apple).toHaveBeenCalledOnce();
  expect(appleShutdown).toHaveBeenCalledTimes(2);
});

test('Android shutdown uses the owning package capability', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await expect(shutdownHost().android.shutdownTarget(device, signal())).resolves.toEqual(success());
  expect(androidShutdown).toHaveBeenCalledOnce();
  expect(shutdownLoaders.android).toHaveBeenCalledOnce();
});

test('a shutdown guard refuses every shutdown path before the owner runtime loads', async () => {
  const denied = new Error('policy denies device-shutdown');
  const host = shutdownHost(() => {
    throw denied;
  });
  const device = appleDevice();

  await expect(host.apple.shutdownTarget(device, signal())).rejects.toBe(denied);
  await expect(host.close?.shutdownTarget(device)).rejects.toBe(denied);
  await expect(
    host.android.shutdownTarget(
      { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator', booted: true },
      signal(),
    ),
  ).rejects.toBe(denied);
  expect(shutdownLoaders.apple).not.toHaveBeenCalled();
  expect(shutdownLoaders.android).not.toHaveBeenCalled();
  expect(appleShutdown).not.toHaveBeenCalled();
  expect(androidShutdown).not.toHaveBeenCalled();
});

function shutdownHost(assertShutdownAllowed?: () => void) {
  return createDeviceShutdownRuntimeHost(
    {
      appleTools: {
        isXcrunAvailable: async () => true,
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      },
      commands: {
        which: async () => 'tool',
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      },
    },
    shutdownLoaders,
    assertShutdownAllowed,
  );
}

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
