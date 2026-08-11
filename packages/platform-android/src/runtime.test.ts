import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidPlatformRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test.each([
  ['emulator', device],
  ['device', { ...device, kind: 'device' as const }],
])('classifies the Android %s runtime denominator', async (_name, runtimeDevice) => {
  const listApps = vi.fn(async () => [{ id: 'com.example.app', name: 'Example' }]);
  const host = {
    commands: {
      which: async () => 'tool',
      run: async () => ({ stdout: '1', stderr: '', exitCode: 0 }),
    },
    toolchains: { prepare: async () => {} },
    clock: { now: () => 1, sleep: async () => {} },
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps },
      harmonyos: { listApps: async () => [] },
    },
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: { keepHot: () => {} },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    screenRecording: {
      android: {
        resolve: async () => ({
          mode: 'local' as const,
          start: async () => {
            throw new Error('unused');
          },
          signal: async () => true,
          isRunning: async () => false,
          exists: async () => false,
          pull: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          remove: async () => true,
          readManifest: async () => undefined,
          writeManifest: async () => {},
          removeManifest: async () => {},
        }),
      },
    },
  } as unknown as PlatformRuntimeHost;
  const binding = await createAndroidPlatformRuntime(host).bind({
    device: runtimeDevice,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const { facts } = binding;
  expect(facts.device.providerMode).toBe('local');
  expect(facts.operations.networkDump).toEqual({ available: true });
  expect(facts.operations.listApps).toEqual({ available: true });
  expect(facts.operations.screenRecordingStart).toEqual({ available: true });
  expect(facts.operations.screenRecordingReattach).toEqual({ available: true });
  expect(facts.operations.screenRecordingCleanup).toEqual({ available: true });
  expect(facts.operations.ensureReady).toEqual({ available: true });
  expect(facts.operations.bootTarget).toEqual({ available: true });
  expect(facts.operations.bootTargetHeadless.available).toBe(runtimeDevice.kind === 'emulator');

  await expect(binding.operations.ensureReady?.({})).resolves.toMatchObject({
    id: runtimeDevice.id,
    booted: true,
  });
  await expect(
    binding.operations.listApps?.({ device: runtimeDevice, filter: 'all' }),
  ).resolves.toEqual([{ id: 'com.example.app', name: 'Example' }]);
  expect(listApps).toHaveBeenCalledWith(runtimeDevice, 'all', expect.any(AbortSignal));

  await expect(binding.operations.bootTarget?.({})).resolves.toMatchObject({
    id: runtimeDevice.id,
    booted: true,
  });

  if (runtimeDevice.kind === 'emulator') {
    await expect(binding.operations.bootTargetHeadless?.({})).resolves.toMatchObject({
      id: runtimeDevice.id,
      booted: true,
    });
  } else {
    expect(binding.operations.bootTargetHeadless).toBeUndefined();
  }
});
