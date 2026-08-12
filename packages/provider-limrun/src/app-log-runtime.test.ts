import {
  appStateUse,
  appsRuntimeUse,
  bootTargetUse,
  narrowDeviceBinding,
  type PlatformRequestScope,
  type PlatformRuntimeHost,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createLimrunAppLogEnvelope } from './app-log-descriptor.ts';
import { createLimrunPlatformRuntimeOwner } from './app-log-runtime.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-a',
  name: 'Limrun iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test('rejects a cross-platform durable descriptor before provider reconnection', async () => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createLimrunPlatformRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => true,
    openCurrent: async () => undefined,
    reconnect,
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }),
  });
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
  const owner = createLimrunPlatformRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => true,
    openCurrent,
    reconnect,
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }),
  });
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
  const owner = createLimrunPlatformRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => false,
    openCurrent,
    reconnect,
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }),
  });
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
    reason: 'unsupported-provider-mode',
  });
  expect(binding.facts.operations.appLogReattach).toEqual({ available: true });
  expect(binding.facts.operations.appLogCleanup).toEqual({ available: true });
  expect(binding.facts.operations.appState).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(binding.facts.operations.ensureReady).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(binding.facts.operations.listApps).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(() => narrowDeviceBinding(binding, appStateUse)).toThrow();
  expect(() => narrowDeviceBinding(binding, bootTargetUse)).toThrow();
  expect(() => narrowDeviceBinding(binding, appsRuntimeUse)).toThrow();
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
  const owner = createLimrunPlatformRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => true,
    openCurrent: async () => undefined,
    reconnect,
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }),
  });

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
  const owner = createLimrunPlatformRuntimeOwner({
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
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => true,
    openCurrent: async () => undefined,
    reconnect: async () => ({ status: 'missing' }),
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }),
  });
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
  const owner = createLimrunPlatformRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => true,
    openCurrent: async () => undefined,
    reconnect: async () => ({ status: 'missing' }),
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }),
  });
  const binding = await owner.bind({ device: runtimeDevice, intent: { kind: 'ordinary' }, scope });
  expect(binding.facts.device.providerMode).toBe('provider-runtime');
  expect(binding.facts.operations.appState.available).toBe(runtimeDevice.platform === 'android');
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
  expect(binding.facts.operations.ensureReady).toEqual({ available: true });
  expect(binding.facts.operations.bootTarget).toEqual({ available: true });
  expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
  expect(binding.facts.operations.listApps).toEqual({ available: true });
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
  const owner = createLimrunPlatformRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => false,
    openCurrent: async () => undefined,
    reconnect: async () => ({ status: 'missing' }),
    listApps: async () => [],
    getAppState,
  });

  const facts = await owner.inspectFacts(staleDevice);
  expect(facts.operations.ensureReady).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(facts.operations.appState).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  await expect(
    owner.bind({ device: staleDevice, intent: { kind: 'ordinary' }, scope }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-session-unavailable' },
  });
  expect(getAppState).not.toHaveBeenCalled();
});

function unusedHost(): PlatformRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
    artifacts: {
      resolveSession: (sessionId) => ({
        outputPath: `/sessions/${sessionId}/app.log`,
        pidPath: `/sessions/${sessionId}/app-log.pid`,
      }),
    },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    outputs: {
      readTail: async () => '',
      openAppend: async () => {
        throw new Error('unused');
      },
    },
    processTransports: {
      resolve: async () => ({ mode: 'local' }),
    },
    processes: {
      start: async () => {
        throw new Error('unused');
      },
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: { now: () => 1, sleep: async () => {} },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/session/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: { resolve: async () => ({ mode: 'local' }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: { keepHot: () => {} },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    screenRecording: unusedScreenRecordingHost(),
  };
}

function unusedScreenRecordingHost(): PlatformRuntimeHost['screenRecording'] {
  return {
    outputs: { prepare: async () => {} },
    apple: {
      availability: async () => ({ available: true }),
      runRunner: async () => ({}),
      startSimulator: async () => {
        throw new Error('unused');
      },
      inspectProcess: async () => 'missing',
      terminateProcess: async () => 'already-missing',
      inspectRunner: async () => 'missing',
      retrieveRunnerRecording: async () => {},
      captureClockAnchor: async () => undefined,
      isRunnerBundleId: async () => false,
    },
    android: {
      resolve: async () => {
        throw new Error('unused');
      },
    },
    harmony: {
      start: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      stop: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      findMedia: async () => undefined,
      stageMedia: async () => false,
      stagedFileSize: async () => undefined,
      pull: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      remove: async () => true,
      removeMedia: async () => true,
    },
    web: { resolve: async () => undefined },
    finalize: { complete: async () => ({}) },
  };
}
