import { expect, test, vi } from 'vitest';
import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
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
    localInteractors: { resolve: async () => ({}) },
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
  expect(facts.operations.captureSnapshot).toEqual({ available: true });
  expect(facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
  expect(facts.operations.captureSnapshotWithoutActiveApp).toEqual({ available: true });
  expect(facts.operations.setViewport).toMatchObject({ available: false });
  expect(binding.operations.setViewport).toBeUndefined();
  expect(facts.operations.captureScreenshot).toEqual({ available: true });
  expect(binding.operations.captureScreenshot).toBeTypeOf('function');
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
    localInteractors: { resolve: async () => ({}) },
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
  expect(binding.facts.operations.setViewport).toMatchObject({ available: false });
  expect(binding.operations.appState).toBeUndefined();
});

type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

test.each([
  {
    name: 'HarmonyOS emulator',
    device: { ...device, id: 'harmony-emulator', kind: 'emulator' as const },
    legacy: {
      openTarget: true,
      prepareAppleRunner: false,
      closeTarget: true,
      runtimeHints: false,
      portReverse: false,
    },
  },
  {
    name: 'HarmonyOS device',
    device,
    // Legacy HDC open/close dispatch supports HarmonyOS emulator/device; runtime hints and
    // Apple runner preparation had no HarmonyOS implementation.
    legacy: {
      openTarget: true,
      prepareAppleRunner: false,
      closeTarget: true,
      runtimeHints: false,
      portReverse: false,
    },
  },
  {
    name: 'synthetic HarmonyOS simulator',
    device: { ...device, id: 'harmony-simulator', kind: 'simulator' as const },
    legacy: {
      openTarget: false,
      prepareAppleRunner: false,
      closeTarget: false,
      runtimeHints: false,
      portReverse: false,
    },
  },
] satisfies ReadonlyArray<
  Readonly<{ name: string; device: DeviceInfo; legacy: LegacyLifecycleCell }>
>)(
  'classifies the $name lifecycle denominator against the legacy dispatch cell',
  async ({ device: runtimeDevice, legacy }) => {
    const host = {
      processTransports: { resolve: async () => ({ mode: 'local' as const }) },
      appInventory: { harmonyos: { listApps: async () => [] } },
      localInteractors: { resolve: async () => ({}) },
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
    expect(facts.device.providerMode).toBe('local');
    expect(facts.operations.networkDump).toMatchObject({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(facts.operations.appLogInspect).toEqual({ available: true });
    for (const operation of [
      'screenRecordingStart',
      'screenRecordingReattach',
      'screenRecordingCleanup',
    ] as const) {
      expect(facts.operations[operation].available).toBe(runtimeDevice.kind === 'device');
    }
    expect(facts.operations.ensureReady).toMatchObject({ available: true });
    expect(facts.operations.bootTarget).toMatchObject({ available: false });
    expect(facts.operations.bootTargetHeadless).toMatchObject({ available: false });
    expect(facts.operations.captureSnapshot.available).toBe(
      runtimeDevice.kind === 'emulator' || runtimeDevice.kind === 'device',
    );
    expect(binding.operations.captureSnapshot).toBeTypeOf(
      runtimeDevice.kind === 'simulator' ? 'undefined' : 'function',
    );
    expectLegacyLifecycleCell(binding, legacy);
  },
);

function expectLegacyLifecycleCell(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  legacy: LegacyLifecycleCell,
): void {
  const operations = [
    ['openTarget', ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication']],
    ['prepareAppleRunner', ['prepareAppleRunner']],
    ['closeTarget', ['closeApplication', 'finalizeApplicationClose']],
    ['runtimeHints', ['applyRuntimeHints', 'clearRuntimeHints']],
    ['portReverse', ['configureProviderPortReverse']],
  ] as const;
  for (const [facet, names] of operations) {
    for (const name of names) {
      expect(binding.facts.operations[name].available).toBe(legacy[facet]);
      if (legacy[facet]) expect(binding.operations[name]).toBeTypeOf('function');
      else expect(binding.operations[name]).toBeUndefined();
    }
  }
}
