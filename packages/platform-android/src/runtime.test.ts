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
const appStateUnavailable = {
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Android appstate is supported only for Android emulators and devices.',
} as const;
const unknownKindDevice = { ...device, kind: 'unknown' } as unknown as DeviceInfo;

test.each([
  ['emulator', device],
  ['device', { ...device, kind: 'device' as const }],
  ['unknown', unknownKindDevice],
])('classifies the Android %s runtime denominator', async (_name, runtimeDevice) => {
  const listApps = vi.fn(async () => [{ id: 'com.example.app', name: 'Example' }]);
  const appState = vi.fn(async () => ({
    stdout: 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}',
  }));
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
    appState: {
      android: { run: appState },
      harmonyos: { run: async () => ({ stdout: '' }) },
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
  expect(facts.operations.appState).toEqual({ available: true });
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
  await expect(binding.operations.appState?.()).resolves.toEqual({
    package: 'com.example.app',
    activity: '.MainActivity',
  });
  expect(appState).toHaveBeenCalledWith(
    runtimeDevice,
    { args: ['shell', 'dumpsys', 'window', 'windows'], allowFailure: true },
    expect.any(AbortSignal),
  );

  if (runtimeDevice.kind === 'emulator') {
    await expect(binding.operations.bootTargetHeadless?.({})).resolves.toMatchObject({
      id: runtimeDevice.id,
      booted: true,
    });
  } else {
    expect(binding.operations.bootTargetHeadless).toBeUndefined();
  }
});

test('rejects the non-discovered Android simulator cell for appstate', async () => {
  const runtimeDevice = { ...device, kind: 'simulator' as const };
  const host = {
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
    deviceReadiness: { android: { ensureReady: async (selected: DeviceInfo) => selected } },
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

  expect(binding.facts.operations.appState).toEqual(appStateUnavailable);
  expect(binding.operations.appState).toBeUndefined();
});
