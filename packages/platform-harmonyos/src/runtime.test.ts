import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyPlatformRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-fact',
  name: 'HarmonyOS',
  kind: 'device',
  target: 'mobile',
  booted: true,
};
const appStateUnavailable = {
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'HarmonyOS appstate is supported only for HarmonyOS emulators and devices.',
} as const;

test.each([
  ['device', device],
  ['emulator', { ...device, kind: 'emulator' as const }],
])('classifies the HarmonyOS %s runtime denominator', async (_name, runtimeDevice) => {
  const listApps = vi.fn(async () => [{ id: 'com.example.application', name: 'application' }]);
  const host = {
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    appInventory: { harmonyos: { listApps } },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: {
        run: async () => ({
          stdout:
            'Mission ID #76  mission name #[#com.example.harmony:entry:MainAbility]\nstate #FOREGROUND',
        }),
      },
    },
  } as unknown as PlatformRuntimeHost;
  const binding = await createHarmonyPlatformRuntime(host).bind({
    device: runtimeDevice,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const { facts } = binding;
  const recordingAvailable = runtimeDevice.kind === 'device';
  expect(facts.device.providerMode).toBe('local');
  expect(facts.operations.networkDump).toMatchObject({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  expect(facts.operations.appLogInspect).toEqual({ available: true });
  expect(facts.operations.screenRecordingStart.available).toBe(recordingAvailable);
  expect(facts.operations.screenRecordingReattach.available).toBe(recordingAvailable);
  expect(facts.operations.screenRecordingCleanup.available).toBe(recordingAvailable);
  expect(facts.operations.appState).toEqual({ available: true });
  expect(facts.operations.ensureReady).toEqual({ available: true });
  expect(facts.operations.bootTarget).toMatchObject({ available: false });
  expect(facts.operations.bootTargetHeadless).toMatchObject({ available: false });
  expect(facts.operations.listApps).toEqual({ available: true });
  await expect(binding.operations.ensureReady?.({})).resolves.toMatchObject({ booted: true });
  await expect(
    binding.operations.listApps?.({ device: runtimeDevice, filter: 'all' }),
  ).resolves.toEqual([{ id: 'com.example.application', name: 'application' }]);
  expect(listApps).toHaveBeenCalledWith(runtimeDevice, 'all', expect.any(AbortSignal));
  await expect(binding.operations.appState?.()).resolves.toEqual({
    package: 'com.example.harmony',
    activity: 'MainAbility',
  });
});

test('rejects the non-discovered HarmonyOS simulator cell for appstate', async () => {
  const runtimeDevice = { ...device, kind: 'simulator' as const };
  const host = {
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
  } as unknown as PlatformRuntimeHost;
  const binding = await createHarmonyPlatformRuntime(host).bind({
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
