import { narrowDeviceBinding, type DeviceBinding } from '@agent-device/contracts/platform-runtime';
import {
  appStateUse,
  appsRuntimeUse,
  bootTargetUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createLimrunAppLogEnvelope } from './app-log-descriptor.ts';
import {
  limrunIosSimulator as device,
  limrunOwnerOptions,
  limrunScope as scope,
  unusedLimrunHost as unusedHost,
} from './app-log-runtime.fixtures.ts';
import { createLimrunPlatformRuntimeOwner } from './app-log-runtime.ts';

test('rejects a cross-platform durable descriptor before provider reconnection', async () => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      reconnect,
    }),
  );
  const binding = await owner.bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });
  expect(binding.facts.device.providerMode).toBe('provider-runtime');
  const envelope = createLimrunAppLogEnvelope({
    sessionId: 'session',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: {
      transport: 'limrun-log-poller',
      platform: 'android',
      leaseId: 'lease-a',
      instanceId: 'instance-a',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    },
  });
  await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
  });
  await expect(binding.operations.appLogCleanup?.({ envelope })).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'ownership-fence-lost',
  });
  expect(reconnect).not.toHaveBeenCalled();
});

test('rejects cross-session paths before reconnecting or opening a provider reader', async () => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const openCurrent = vi.fn(async () => undefined);
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      openCurrent,
      reconnect,
    }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  const envelope = createLimrunAppLogEnvelope({
    sessionId: 'one',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: {
      transport: 'limrun-log-poller',
      platform: 'ios',
      leaseId: 'lease-a',
      instanceId: 'instance-a',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/two/app.log',
    },
  });

  await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
  });
  await expect(
    binding.operations.appLogStart?.({
      sessionId: 'one',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/two/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(reconnect).not.toHaveBeenCalled();
  expect(openCurrent).not.toHaveBeenCalled();
});

test('keeps exact-owner app-log recovery available without a process-local session', async () => {
  const openCurrent = vi.fn(async () => undefined);
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      hasLiveSession: () => false,
      openCurrent,
      reconnect,
    }),
  );
  const binding = await owner.bind({
    device,
    intent: {
      kind: 'exact-owner',
      owner: owner.owner,
      fence: { token: 'fence', generation: 1 },
    },
    scope,
  });
  const envelope = createLimrunAppLogEnvelope({
    sessionId: 'session',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: {
      transport: 'limrun-log-poller',
      platform: 'ios',
      leaseId: 'lease-a',
      instanceId: 'instance-a',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/session/app.log',
    },
  });

  expect(binding.operations.appLogReattach).toEqual(expect.any(Function));
  expect(binding.operations.appState).toBeUndefined();
  expect(binding.operations.ensureReady).toBeUndefined();
  expect(binding.operations.listApps).toBeUndefined();
  expect(binding.facts.operations.appLogInspect).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(binding.facts.operations.appLogReattach).toEqual({ available: true });
  expect(binding.facts.operations.appLogCleanup).toEqual({ available: true });
  expect(binding.facts.operations.appState).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(binding.facts.operations.ensureReady).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(binding.facts.operations.listApps).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(() => narrowDeviceBinding(binding, appStateUse)).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
  );
  expect(() => narrowDeviceBinding(binding, bootTargetUse)).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
  );
  expect(() => narrowDeviceBinding(binding, appsRuntimeUse)).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
  );
  await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toEqual({
    status: 'missing',
  });
  await expect(binding.operations.appLogCleanup?.({ envelope })).resolves.toEqual({
    status: 'cleaned',
  });
  expect(openCurrent).not.toHaveBeenCalled();
  expect(reconnect).toHaveBeenCalledOnce();
});

test.each([
  {
    name: 'HarmonyOS device carrying an Android-shaped Limrun id',
    device: {
      ...device,
      platform: 'harmonyos' as const,
      appleOs: undefined,
      id: 'limrun:android:lease-a',
      kind: 'device' as const,
    },
  },
  {
    name: 'non-iOS Apple leaf',
    device: { ...device, appleOs: 'macos' as const, target: 'desktop' as const },
  },
  {
    name: 'physical Apple kind',
    device: { ...device, kind: 'device' as const },
  },
])('rejects exact binding for an impossible Limrun $name', async ({ device: invalidDevice }) => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      reconnect,
    }),
  );

  await expect(
    owner.bind({
      device: invalidDevice,
      intent: {
        kind: 'exact-owner',
        owner: owner.owner,
        fence: { token: 'fence', generation: 1 },
      },
      scope,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  expect(reconnect).not.toHaveBeenCalled();
});

test('serves provider-owned network from the canonical session app log without local recovery', async () => {
  const commandRun = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  const base = unusedHost();
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      host: {
        ...base,
        commands: { ...base.commands, run: commandRun },
        appLogs: {
          ...base.appLogs,
          readRecent: async () => ({
            path: '/sessions/session/app.log',
            exists: true,
            text: '2026-08-10T10:00:00Z GET https://limrun.example.test status=200\n',
            skippedLines: 0,
          }),
        },
      },
    }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  await expect(
    binding.operations.networkDump?.({
      sessionId: 'session',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 4000,
    }),
  ).resolves.toMatchObject({
    source: 'app-log',
    backend: 'ios-simulator',
    dump: { entries: [{ url: 'https://limrun.example.test' }] },
  });
  expect(commandRun).not.toHaveBeenCalled();
});

test.each([
  ['iOS simulator', device],
  [
    'Android emulator',
    {
      platform: 'android' as const,
      id: 'limrun:android:lease-a',
      name: 'Limrun Android',
      kind: 'emulator' as const,
      target: 'mobile' as const,
      booted: true,
    },
  ],
])('classifies the direct Limrun %s runtime denominator', async (_name, runtimeDevice) => {
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      getInteractor: () => ({}) as never,
    }),
  );
  const binding = await owner.bind({ device: runtimeDevice, intent: { kind: 'ordinary' }, scope });
  expect(binding.facts.device.providerMode).toBe('provider-runtime');
  expect(binding.facts.operations.appState.available).toBe(runtimeDevice.platform === 'android');
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
  expect(binding.facts.operations.ensureReady).toEqual({ available: true });
  expect(binding.facts.operations.bootTarget).toEqual({ available: true });
  expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
  expect(binding.facts.operations.listApps).toEqual({ available: true });
  expect(binding.facts.operations.captureSnapshot).toEqual({ available: true });
  expect(binding.facts.operations.captureSnapshotWithCustomActions.available).toBe(
    runtimeDevice.platform === 'apple',
  );
  expect(binding.facts.operations.captureSnapshotWithoutActiveApp).toEqual({ available: true });
  expect(binding.facts.operations.setViewport).toMatchObject({ available: false });
  expect(binding.operations.setViewport).toBeUndefined();
  expect(binding.facts.operations.captureScreenshot).toEqual({ available: true });
  expect(binding.operations.captureScreenshot).toBeTypeOf('function');
  // R40/R41: interaction cells ride the same provider interactor the captures do.
  expect(binding.facts.operations.focusPoint).toEqual({ available: true });
  expect(binding.facts.operations.typeText).toEqual({ available: true });
  expect(binding.operations.focusPoint).toBeTypeOf('function');
  expect(binding.operations.typeText).toBeTypeOf('function');
  expect(binding.operations.captureSnapshot).toBeTypeOf('function');
  // Limrun owns the device remotely and exposes no local point-read tool, so the live read is
  // unavailable and `get` answers from the captured tree — never by borrowing the local runtime.
  expect(binding.facts.operations.readTextAtPoint).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(binding.operations.readTextAtPoint).toBeUndefined();
  expectLimrunNavigationAndKeyboardFacts(binding, runtimeDevice);
  await expect(
    binding.operations.listApps?.({ device: runtimeDevice, filter: 'all' }),
  ).resolves.toEqual([]);
  await expect(binding.operations.ensureReady?.({})).resolves.toMatchObject({
    id: runtimeDevice.id,
    booted: true,
  });
  await expect(binding.operations.bootTarget?.({})).resolves.toMatchObject({
    id: runtimeDevice.id,
    booted: true,
  });
  if (runtimeDevice.platform === 'android') {
    await expect(binding.operations.appState?.()).resolves.toEqual({
      package: 'com.example.app',
      activity: '.MainActivity',
    });
  } else {
    expect(binding.operations.appState).toBeUndefined();
  }
});

test('fails closed for a stale Android identity before exposing facts or binding operations', async () => {
  const getAppState = vi.fn(async () => ({
    package: 'com.example.app',
    activity: '.MainActivity',
  }));
  const staleDevice: DeviceInfo = {
    platform: 'android',
    id: 'limrun:android:released-lease',
    name: 'Released Limrun Android',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      hasLiveSession: () => false,
      getAppState,
    }),
  );

  const facts = await owner.inspectFacts(staleDevice);
  expect(facts.operations.ensureReady).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(facts.operations.appState).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(facts.operations.captureSnapshot).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(facts.operations.captureSnapshotWithCustomActions).toMatchObject({ available: false });
  expect(facts.operations.captureSnapshotWithoutActiveApp).toMatchObject({ available: false });
  expect(facts.operations.setViewport).toMatchObject({ available: false });
  expect(facts.operations.captureScreenshot).toMatchObject({ available: false });
  expect(facts.operations.focusPoint).toMatchObject({ available: false });
  expect(facts.operations.typeText).toMatchObject({ available: false });
  await expect(
    owner.bind({ device: staleDevice, intent: { kind: 'ordinary' }, scope }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-session-unavailable' },
  });
  expect(getAppState).not.toHaveBeenCalled();
});

/**
 * back/orientation are admitted on both direct-session platforms; home/tv-remote differ by
 * platform (the Android leg reuses the local family's interactor factory, the iOS leg refuses
 * both explicitly); keyboard status/dismiss/enter reuse that same Android-only interactor.
 */
function expectLimrunNavigationAndKeyboardFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  runtimeDevice: DeviceInfo,
): void {
  const isAndroid = runtimeDevice.platform === 'android';
  expect(binding.facts.operations.back).toEqual({ available: true });
  expect(binding.operations.back).toBeTypeOf('function');
  expect(binding.facts.operations.setOrientation).toEqual({ available: true });
  expect(binding.operations.setOrientation).toBeTypeOf('function');
  expect(binding.facts.operations.home.available).toBe(isAndroid);
  expect(binding.operations.home).toBeTypeOf(isAndroid ? 'function' : 'undefined');
  if (!isAndroid) {
    expect(binding.facts.operations.home).toMatchObject({
      hint: 'Limrun iOS direct sessions do not expose home yet.',
    });
  }
  // tv-remote additionally requires a real TV target on the Android leg.
  expect(binding.facts.operations.tvRemote.available).toBe(false);
  expect(binding.operations.tvRemote).toBeUndefined();
  expect(binding.facts.operations.tvRemote).toMatchObject({
    hint: isAndroid
      ? 'tv-remote is supported only on Android TV targets.'
      : 'Limrun iOS direct sessions do not expose tv remote control.',
  });
  for (const operation of ['keyboardStatus', 'keyboardDismiss', 'keyboardEnter'] as const) {
    expect(binding.facts.operations[operation].available).toBe(isAndroid);
    expect(binding.operations[operation]).toBeTypeOf(isAndroid ? 'function' : 'undefined');
    if (!isAndroid) {
      expect(binding.facts.operations[operation]).toMatchObject({
        hint: 'Limrun iOS direct sessions do not expose keyboard actions.',
      });
    }
  }
}

// R52/R53: Limrun's two session kinds run different interactors. The Android emulator session
// runs the ordinary Android interactor (every tier); the iOS direct session's own
// `performGesture` refuses, so stating that as a fact refuses at admission instead of
// mid-execution — with the interactor's wording preserved.
const limrunAndroid = {
  platform: 'android' as const,
  id: 'limrun:android:lease-a',
  name: 'Limrun Android',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};

test('admits every gesture tier on a Limrun Android session', async () => {
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({ getInteractor: () => ({}) as never }),
  );
  const binding = await owner.bind({
    device: limrunAndroid,
    intent: { kind: 'ordinary' },
    scope,
  });
  for (const operation of [
    'performGesturePlan',
    'performDirectionalFlingPlan',
    'performMultiTouchGesturePlan',
    'performTargetAuthoredDrag',
    'gestureViewport',
    'scrollDirection',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({ available: true });
    expect(binding.operations[operation]).toBeTypeOf('function');
  }
});

test('refuses Limrun iOS gestures at admission while keeping its scroll', async () => {
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({ getInteractor: () => ({}) as never }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  for (const operation of [
    'performGesturePlan',
    'performDirectionalFlingPlan',
    'performMultiTouchGesturePlan',
    'performTargetAuthoredDrag',
    'gestureViewport',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-provider-mode',
      hint: 'Limrun iOS direct sessions do not expose portable gesture execution yet.',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
  // The iOS direct session exposes scrolling directly — no gesture synthesis involved.
  expect(binding.facts.operations.scrollDirection).toEqual({ available: true });
  expect(binding.operations.scrollDirection).toBeTypeOf('function');
});

test('closes every Limrun gesture and scroll cell without a live session', async () => {
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({ getInteractor: () => ({}) as never, hasLiveSession: () => false }),
  );
  const facts = await owner.inspectFacts(limrunAndroid);
  for (const operation of [
    'performGesturePlan',
    'performMultiTouchGesturePlan',
    'performTargetAuthoredDrag',
    'gestureViewport',
    'scrollDirection',
  ] as const) {
    expect(facts.operations[operation].available).toBe(false);
  }
});
