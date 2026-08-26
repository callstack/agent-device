import { expect, test, vi } from 'vitest';
import type { AndroidClipboardShellSupport } from '@agent-device/contracts/android-clipboard-support';
import type { DeviceBinding } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
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
const audioProbeHost: PlatformRuntimeHost['audioProbe'] = {
  hostCapture: {
    info: {
      source: 'system-audio',
      backend: 'fixture',
      sourceCount: 0,
      notes: () => [],
    },
    start: async () => {
      throw new Error('Audio probe is outside this runtime fixture.');
    },
    inspectProcess: async () => 'missing',
    terminateProcess: async () => 'already-missing',
  },
  web: { resolve: async () => undefined },
  ownedProcesses: { replace: () => {}, clear: () => {} },
};

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
    androidTools: { probeClipboardShellSupport: async () => 'supported' as const },
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
      appleAutomation: {
        keepHot: () => {},
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    localInteractors: { resolve: async () => ({}) },
    audioProbe: audioProbeHost,
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
  // uiautomator reads text at a point over the same adb transport the capture uses.
  expect(facts.operations.readTextAtPoint).toEqual({ available: true });
  expect(facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
  expect(facts.operations.captureSnapshotWithoutActiveApp).toEqual({ available: true });
  expect(facts.operations.setViewport).toMatchObject({ available: false });
  expect(binding.operations.setViewport).toBeUndefined();
  expect(facts.operations.captureScreenshot).toEqual({ available: true });
  // Interaction cells (R40/R41): every real Android kind drives touch and text through adb;
  // only the synthetic `simulator` row (covered below) lacks a device behind it.
  expect(facts.operations.focusPoint).toEqual({ available: true });
  expect(facts.operations.typeText).toEqual({ available: true });
  expect(facts.operations.hoverPoint).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'hover raises pointer hover state and is available on web targets only. On touch platforms use longpress for hold gestures.',
  });
  expect(binding.operations.focusPoint).toBeTypeOf('function');
  expect(binding.operations.typeText).toBeTypeOf('function');
  expect(binding.operations.captureScreenshot).toBeTypeOf('function');
  expect(binding.operations.captureSnapshot).toBeTypeOf('function');
  expect(binding.operations.readTextAtPoint).toBeTypeOf('function');

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
    androidTools: { probeClipboardShellSupport: async () => 'supported' as const },
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    localInteractors: { resolve: async () => ({}) },
    audioProbe: audioProbeHost,
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

function androidNavigationHostFixture(
  probeClipboardShellSupport: () => Promise<AndroidClipboardShellSupport> = async () => 'supported',
) {
  return {
    androidTools: {
      probeClipboardShellSupport,
      runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
    deviceReadiness: { android: { ensureReady: async (selected: DeviceInfo) => selected } },
    localInteractors: { resolve: async () => ({}) },
    audioProbe: audioProbeHost,
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
}

test.each([
  ['emulator', device],
  ['device', { ...device, kind: 'device' as const }],
  ['unknown', unknownKindDevice],
])(
  'classifies Android %s back/home/orientation/keyboard facts through the shared touch gate',
  async (_name, runtimeDevice) => {
    const binding = await createAndroidPlatformRuntime(androidNavigationHostFixture()).bind({
      device: runtimeDevice,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    const { facts } = binding;

    // back/home/orientation/keyboard status+dismiss+enter all ride the same adb-driven touch
    // gate as focus/type: available for every real Android kind, parity with the retired buckets.
    for (const operation of [
      'back',
      'home',
      'setOrientation',
      'keyboardStatus',
      'keyboardDismiss',
      'keyboardEnter',
    ] as const) {
      expect(facts.operations[operation]).toEqual({ available: true });
      expect(binding.operations[operation]).toBeTypeOf('function');
    }

    // tv-remote additionally requires a real TV target; none of these rows carry one.
    expect(facts.operations.tvRemote).toEqual({
      available: false,
      reason: 'unsupported-device-kind',
      hint: 'tv-remote is supported only on Android TV targets.',
    });
    expect(binding.operations.tvRemote).toBeUndefined();
  },
);

test('admits Android tv-remote only for a real TV target', async () => {
  const tvDevice = { ...device, kind: 'emulator' as const, target: 'tv' as const };
  const binding = await createAndroidPlatformRuntime(androidNavigationHostFixture()).bind({
    device: tvDevice,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  expect(binding.facts.operations.tvRemote).toEqual({ available: true });
  expect(binding.operations.tvRemote).toBeTypeOf('function');
});

// R55 parity: the retired `clipboard` bucket was `ANDROID_ALL` (emulator/device/unknown) with no
// Android admission closure, so `cmd clipboard get/set text` is admitted on every real kind and
// refused only on the synthetic `simulator` row the bucket never listed. (`unknown` is the
// bucket's name for a device with no declared kind, which `DeviceKind` cannot express.)
test('admits both clipboard halves and the app switcher on every real Android kind', async () => {
  for (const kind of ['emulator', 'device'] as const) {
    const binding = await createAndroidPlatformRuntime(androidNavigationHostFixture()).bind({
      device: { ...device, id: `android-${kind}`, kind },
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    expect(binding.facts.operations.readClipboard).toEqual({ available: true });
    expect(binding.facts.operations.writeClipboard).toEqual({ available: true });
    expect(binding.operations.readClipboard).toBeTypeOf('function');
    expect(binding.operations.writeClipboard).toBeTypeOf('function');
    // R56: `app-switcher` shares `home`'s cell — one `input keyevent` on every real kind.
    expect(binding.facts.operations.appSwitcher).toEqual({ available: true });
    expect(binding.operations.appSwitcher).toBeTypeOf('function');
    // R57: the deep link opens through `am start` on the same cell.
    expect(binding.facts.operations.triggerAppEvent).toEqual({ available: true });
    expect(binding.operations.triggerAppEvent).toBeTypeOf('function');
    // R58: settings run over adb (`appops`, `settings put`, `pm clear`, …) on that cell too.
    expect(binding.facts.operations.setSetting).toEqual({ available: true });
    expect(binding.operations.setSetting).toBeTypeOf('function');
    // R59: all four alert legs read the same dump and tap with the same `input tap`.
    for (const operation of ['readAlert', 'awaitAlert', 'acceptAlert', 'dismissAlert'] as const) {
      expect(binding.facts.operations[operation]).toEqual({ available: true });
      expect(binding.operations[operation]).toBeTypeOf('function');
    }
  }
});

test('the synthetic Android simulator cell refuses back/home/orientation/keyboard like every other touch operation', async () => {
  const simulatorDevice = { ...device, id: 'android-simulator', kind: 'simulator' as const };
  const binding = await createAndroidPlatformRuntime(androidNavigationHostFixture()).bind({
    device: simulatorDevice,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const { facts } = binding;

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
    expect(facts.operations[operation].available).toBe(false);
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
      androidTools: { probeClipboardShellSupport: async () => 'supported' as const },
      processTransports: { resolve: async () => ({ mode: 'local' as const }) },
      appInventory: {
        apple: { listApps: async () => [] },
        android: { listApps: async () => [] },
        harmonyos: { listApps: async () => [] },
      },
      localInteractors: { resolve: async () => ({}) },
      audioProbe: audioProbeHost,
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
    expect(facts.operations.readTextAtPoint.available).toBe(runtimeDevice.kind !== 'simulator');
    // R40/R41: the synthetic simulator row is the one Android cell with no adb touch or text.
    expect(facts.operations.focusPoint.available).toBe(runtimeDevice.kind !== 'simulator');
    expect(facts.operations.typeText.available).toBe(runtimeDevice.kind !== 'simulator');
    expect(binding.operations.focusPoint).toBeTypeOf(
      runtimeDevice.kind === 'simulator' ? 'undefined' : 'function',
    );
    expect(binding.operations.typeText).toBeTypeOf(
      runtimeDevice.kind === 'simulator' ? 'undefined' : 'function',
    );
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

// R52/R53: the Android gesture-tier and scroll cells. The one gate the retired
// `requireGestureSupported` carried on Android was the TV target, which it applied to two-contact
// synthesis and to target-authored drag but never to a plain one-contact fling or pan.
test.each([
  // name, device, plan, multiTouch, drag, scroll
  ['emulator', device, true, true, true, true],
  ['physical device', { ...device, kind: 'device' as const }, true, true, true, true],
  ['unknown kind', unknownKindDevice, true, true, true, true],
  ['TV target', { ...device, target: 'tv' as const }, true, false, false, true],
  [
    'synthetic simulator row',
    { ...device, kind: 'simulator' as const },
    false,
    false,
    false,
    false,
  ],
])(
  'declares the Android %s gesture and scroll cells',
  async (_name, runtimeDevice, plan, multiTouch, drag, scroll) => {
    const facts = await createAndroidPlatformRuntime(gestureHost()).inspectFacts(runtimeDevice);
    expect(facts.operations.performGesturePlan.available).toBe(plan);
    // Android honors a direction-authored fling's speed semantics, so it shares the plan cell.
    expect(facts.operations.performDirectionalFlingPlan.available).toBe(plan);
    expect(facts.operations.performMultiTouchGesturePlan.available).toBe(multiTouch);
    expect(facts.operations.performTargetAuthoredDrag.available).toBe(drag);
    expect(facts.operations.gestureViewport.available).toBe(plan);
    expect(facts.operations.scrollDirection.available).toBe(scroll);
  },
);

test('carries the retired Android TV hints verbatim', async () => {
  const facts = await createAndroidPlatformRuntime(gestureHost()).inspectFacts({
    ...device,
    target: 'tv',
  });
  expect(facts.operations.performMultiTouchGesturePlan).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'Android TV has no touch input — this gesture is supported on Android phones, tablets, and the iOS simulator only.',
  });
  expect(facts.operations.performTargetAuthoredDrag).toMatchObject({
    available: false,
    hint: expect.stringContaining('source hold, timed movement, and destination hold'),
  });
});

test('binds only the Android gesture tiers the target admitted', async () => {
  const bind = async (runtimeDevice: DeviceInfo) =>
    await createAndroidPlatformRuntime(gestureHost()).bind({
      device: runtimeDevice,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
  const phone = await bind(device);
  expect(phone.operations.performMultiTouchGesturePlan).toBeTypeOf('function');
  expect(phone.operations.scrollDirection).toBeTypeOf('function');
  const tv = await bind({ ...device, target: 'tv' });
  expect(tv.operations.performGesturePlan).toBeTypeOf('function');
  expect(tv.operations.performMultiTouchGesturePlan).toBeUndefined();
  expect(tv.operations.performTargetAuthoredDrag).toBeUndefined();
});

function gestureHost(): PlatformRuntimeHost {
  return {
    androidTools: { probeClipboardShellSupport: async () => 'supported' as const },
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
    localInteractors: { resolve: async () => ({}) },
    audioProbe: audioProbeHost,
    screenRecording: { android: { resolve: async () => ({ mode: 'local' as const }) } },
  } as unknown as PlatformRuntimeHost;
}

// R55 defect, found on a Pixel 9 Pro XL / Android 36 emulator: the retired bucket admitted both
// clipboard halves on every real Android kind, `capabilities` advertised `clipboard`, and
// `clipboard read` then failed with `UNSUPPORTED_OPERATION` from the leaf. Admission now probes
// the same condition the leaf checks, so a build with no clipboard shell command refuses up front.
test('refuses both clipboard halves when the build reports no clipboard shell', async () => {
  const binding = await createAndroidPlatformRuntime(
    androidNavigationHostFixture(async () => 'unsupported'),
  ).bind({
    device: { ...device, id: 'android-no-clipboard-shell', kind: 'device' },
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  for (const key of ['readClipboard', 'writeClipboard'] as const) {
    expect(binding.facts.operations[key]).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
    // Never admitted, so never bound: nothing can throw `unsupported` after the fact.
    expect(binding.operations[key]).toBeUndefined();
  }
  // The probe is scoped to the clipboard; neighbouring adb-driven cells stay admitted.
  expect(binding.facts.operations.appSwitcher).toEqual({ available: true });
});

test.each([['supported'], ['unsupported']] as const)(
  'caches a definitive %s verdict instead of re-probing per inspection',
  async (verdict) => {
    const probe = vi.fn(async () => verdict);
    const runtime = createAndroidPlatformRuntime(androidNavigationHostFixture(probe));
    const target = { ...device, id: `android-probe-cache-${verdict}`, kind: 'device' as const };

    await runtime.inspectFacts(target);
    await runtime.inspectFacts(target);

    expect(probe).toHaveBeenCalledTimes(1);
  },
);

// The failure path is the one that recreates the defect if it guesses. A probe that never got an
// answer must not report the clipboard available — execution would then refuse the very capability
// `capabilities` advertised — and must not be remembered, or one transport blip decides the
// question for the owner's whole life.
test('a failed probe refuses rather than fabricating availability', async () => {
  const binding = await createAndroidPlatformRuntime(
    androidNavigationHostFixture(async () => 'probe-failed'),
  ).bind({
    device: { ...device, id: 'android-probe-failed', kind: 'device' },
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  for (const key of ['readClipboard', 'writeClipboard'] as const) {
    expect(binding.facts.operations[key]).toMatchObject({ available: false });
    expect(binding.operations[key]).toBeUndefined();
  }
  // The refusal says it could not determine support, not that the build lacks it.
  const fact = binding.facts.operations.readClipboard;
  expect(fact.available === false && String(fact.hint)).toMatch(/could not determine/i);
});

test('a failed probe is not cached, so the next inspection asks again', async () => {
  const probe = vi
    .fn<() => Promise<AndroidClipboardShellSupport>>()
    .mockResolvedValueOnce('probe-failed')
    .mockResolvedValue('supported');
  const runtime = createAndroidPlatformRuntime(androidNavigationHostFixture(probe));
  const target = { ...device, id: 'android-probe-retry', kind: 'device' as const };

  const first = await runtime.inspectFacts(target);
  const second = await runtime.inspectFacts(target);

  expect(first.operations.readClipboard.available).toBe(false);
  expect(second.operations.readClipboard.available).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
});

test('a host with no clipboard probe refuses rather than assuming support', async () => {
  const host = androidNavigationHostFixture();
  const withoutProbe = { ...host, androidTools: {} } as unknown as PlatformRuntimeHost;

  const facts = await createAndroidPlatformRuntime(withoutProbe).inspectFacts({
    ...device,
    id: 'android-no-probe',
    kind: 'device',
  });

  // Absence of a probe is absence of evidence, not evidence of support.
  expect(facts.operations.readClipboard.available).toBe(false);
  expect(facts.operations.writeClipboard.available).toBe(false);
});
