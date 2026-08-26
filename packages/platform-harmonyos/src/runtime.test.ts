import { expect, test, vi } from 'vitest';
import type { DeviceBinding } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
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
  // HarmonyOS has no point-read tool: `get` answers from the captured tree, which is what the
  // legacy dispatch already did once its Apple-runner fall-through failed.
  expect(facts.operations.readTextAtPoint).toMatchObject({ available: false });
  expect(binding.operations.readTextAtPoint).toBeUndefined();
  // R40/R41: hdc drives touch and text on both real kinds this table enumerates.
  expect(facts.operations.focusPoint).toEqual({ available: true });
  expect(facts.operations.typeText).toEqual({ available: true });
  expect(binding.operations.focusPoint).toBeTypeOf('function');
  expect(binding.operations.typeText).toBeTypeOf('function');
  // back/home/keyboard dismiss+enter share focus's hdc-driven gate on both real kinds.
  for (const operation of [
    'back',
    'home',
    // R56 parity: the retired `HARMONYOS_SUPPORTED_COMMANDS` overlay listed `app-switcher` for
    // both HarmonyOS kinds, and it rides the same hdc key input `home` does.
    'appSwitcher',
    'keyboardDismiss',
    'keyboardEnter',
  ] as const) {
    expect(facts.operations[operation]).toEqual({ available: true });
    expect(binding.operations[operation]).toBeTypeOf('function');
  }
  // orientation and tv-remote never carried a HarmonyOS capability bucket, so both stay
  // unavailable unconditionally even though the interactor is technically callable.
  expect(facts.operations.setOrientation).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  expect(facts.operations.tvRemote).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  expect(binding.operations.setOrientation).toBeUndefined();
  expect(binding.operations.tvRemote).toBeUndefined();
  // Android's live IME status read has no HarmonyOS counterpart.
  expect(facts.operations.keyboardStatus).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'keyboard status/get is not available through the public HarmonyOS HDC API; use keyboard dismiss or enter',
  });
  expect(binding.operations.keyboardStatus).toBeUndefined();
  // R55: HarmonyOS never carried a `clipboard` bucket and is absent from the HarmonyOS overlay
  // set, so neither half was ever admitted here.
  for (const operation of [
    'readClipboard',
    'writeClipboard',
    'triggerAppEvent',
    // R59: `alert` never had a HarmonyOS leaf either — hdc exposes no dialog surface.
    'readAlert',
    'awaitAlert',
    'acceptAlert',
    'dismissAlert',
  ] as const) {
    expect(facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
  // R58: `settings` is the other way round — the retired overlay set listed it for both HarmonyOS
  // kinds, so a real kind admits it off the same hdc gate the interaction leaves use.
  expect(facts.operations.setSetting).toEqual({ available: true });
  expect(binding.operations.setSetting).toBeTypeOf('function');
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
  // The synthetic simulator cell has no device behind it, so the hdc-driven navigation/keyboard
  // gate refuses the same way focus/type does; orientation, tv-remote, and keyboard status stay
  // unavailable regardless of kind.
  for (const operation of [
    'back',
    'home',
    'setOrientation',
    'tvRemote',
    'keyboardStatus',
    'keyboardDismiss',
    'keyboardEnter',
    'readClipboard',
    'writeClipboard',
    'appSwitcher',
    'triggerAppEvent',
    'setSetting',
    'readAlert',
    'awaitAlert',
    'acceptAlert',
    'dismissAlert',
  ] as const) {
    expect(binding.facts.operations[operation].available).toBe(false);
    expect(binding.operations[operation]).toBeUndefined();
  }
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
    expect(facts.operations.readTextAtPoint.available).toBe(false);
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

// R52/R53: hdc synthesizes one contact, so HarmonyOS admits the one-contact tiers on the same
// kind cell its focus/type overlay admitted, and refuses the two tiers it cannot reproduce.
test.each([
  ['device', device],
  ['emulator', { ...device, kind: 'emulator' as const }],
])('declares the HarmonyOS %s gesture and scroll cells', async (_name, runtimeDevice) => {
  const facts = await createHarmonyPlatformRuntime(gestureHost()).inspectFacts(runtimeDevice);
  expect(facts.operations.performGesturePlan).toEqual({ available: true });
  expect(facts.operations.performDirectionalFlingPlan).toEqual({ available: true });
  expect(facts.operations.gestureViewport).toEqual({ available: true });
  expect(facts.operations.scrollDirection).toEqual({ available: true });
  // The retired admission refused two-contact synthesis on every platform that is neither
  // Android nor Apple, with no hint — that is this cell, verbatim.
  expect(facts.operations.performMultiTouchGesturePlan).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  expect(facts.operations.performTargetAuthoredDrag).toMatchObject({
    available: false,
    hint: expect.stringContaining('source hold, timed movement, and destination hold'),
  });
});

test('binds the HarmonyOS gesture tiers it admitted and omits the rest', async () => {
  const binding = await createHarmonyPlatformRuntime(gestureHost()).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  expect(binding.operations.performGesturePlan).toBeTypeOf('function');
  expect(binding.operations.gestureViewport).toBeTypeOf('function');
  expect(binding.operations.scrollDirection).toBeTypeOf('function');
  expect(binding.operations.performMultiTouchGesturePlan).toBeUndefined();
  expect(binding.operations.performTargetAuthoredDrag).toBeUndefined();
});

function gestureHost(): PlatformRuntimeHost {
  return {
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    appInventory: { harmonyos: { listApps: async () => [] } },
    appState: { harmonyos: { run: async () => ({ stdout: '' }) } },
    localInteractors: { resolve: async () => ({}) },
  } as unknown as PlatformRuntimeHost;
}
