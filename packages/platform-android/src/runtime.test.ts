import { expect, test, vi } from 'vitest';
import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
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
      appleAutomation: { keepHot: () => {}, markBooted: () => {} },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    localInteractors: { resolve: async () => ({}) },
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
  expect(facts.operations.captureSnapshot).toEqual({ available: true });
  expect(facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
  expect(facts.operations.captureSnapshotWithoutActiveApp).toEqual({ available: true });
  expect(facts.operations.setViewport).toMatchObject({ available: false });
  expect(binding.operations.setViewport).toBeUndefined();
  expect(facts.operations.captureScreenshot).toEqual({ available: true });
  expect(binding.operations.captureScreenshot).toBeTypeOf('function');
  expect(binding.operations.captureSnapshot).toBeTypeOf('function');

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
    localInteractors: { resolve: async () => ({}) },
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
type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

test.each([
  [
    'emulator',
    device,
    {
      openTarget: true,
      prepareAppleRunner: false,
      closeTarget: true,
      runtimeHints: true,
      portReverse: false,
    },
  ],
  [
    'device',
    { ...device, kind: 'device' as const },
    {
      openTarget: true,
      prepareAppleRunner: false,
      closeTarget: true,
      runtimeHints: true,
      portReverse: false,
    },
  ],
  [
    'synthetic simulator',
    { ...device, id: 'android-simulator', kind: 'simulator' as const },
    {
      openTarget: false,
      prepareAppleRunner: false,
      closeTarget: false,
      runtimeHints: false,
      portReverse: false,
    },
  ],
] satisfies ReadonlyArray<readonly [string, DeviceInfo, LegacyLifecycleCell]>)(
  'classifies the Android %s lifecycle denominator against the legacy dispatch cell',
  async (_name, runtimeDevice, legacy) => {
    const host = {
      processTransports: { resolve: async () => ({ mode: 'local' as const }) },
      appInventory: {
        apple: { listApps: async () => [] },
        android: { listApps: async () => [] },
        harmonyos: { listApps: async () => [] },
      },
      localInteractors: { resolve: async () => ({}) },
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
    expect(facts.operations.screenRecordingStart).toEqual({ available: true });
    expect(facts.operations.screenRecordingReattach).toEqual({ available: true });
    expect(facts.operations.screenRecordingCleanup).toEqual({ available: true });
    expect(facts.operations.ensureReady).toEqual({ available: true });
    expect(facts.operations.bootTarget).toEqual({ available: true });
    expect(facts.operations.bootTargetHeadless.available).toBe(runtimeDevice.kind === 'emulator');
    expect(facts.operations.captureSnapshot.available).toBe(runtimeDevice.kind !== 'simulator');
    expect(binding.operations.captureSnapshot).toBeTypeOf(
      runtimeDevice.kind === 'simulator' ? 'undefined' : 'function',
    );
    expectLifecycleFacts(binding, legacy);
  },
);

function expectLifecycleFacts(
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
