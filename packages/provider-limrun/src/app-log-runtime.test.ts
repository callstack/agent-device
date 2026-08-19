import {
  appStateUse,
  appsRuntimeUse,
  bootTargetUse,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform';
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
  expect(binding.operations.captureSnapshot).toBeTypeOf('function');
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
  await expect(
    owner.bind({ device: staleDevice, intent: { kind: 'ordinary' }, scope }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-session-unavailable' },
  });
  expect(getAppState).not.toHaveBeenCalled();
});
