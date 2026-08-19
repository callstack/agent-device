import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type {
  DeviceBinding,
  NetworkProviderDump,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import type { Interactor } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createWebPlatformRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'web',
  id: 'web',
  name: 'Browser',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

test('preserves a narrow web provider dump including empty successful entries', async () => {
  const dump: NetworkProviderDump = vi.fn(async () => ({
    backend: 'fixture-web',
    entries: [],
    notes: ['provider note'],
  }));
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed', dump })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });

  await expect(binding.operations.networkDump?.(input())).resolves.toEqual({
    source: 'provider',
    backend: 'fixture-web',
    entries: [],
    notes: ['provider note'],
  });
  expect(binding.facts.device.providerMode).toBe('transport-composed');
  expect(binding.facts.operations.appState).toMatchObject({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
  expect(binding.facts.operations.ensureReady).toMatchObject({ available: false });
  expect(binding.facts.operations.bootTarget).toMatchObject({ available: false });
  expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
  expect(binding.facts.operations.listApps).toMatchObject({ available: false });
  expect(binding.facts.operations.captureSnapshot).toEqual({ available: true });
  expect(binding.facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
  expect(binding.facts.operations.captureSnapshotWithoutActiveApp).toEqual({ available: true });
  expect(binding.facts.operations.setViewport).toEqual({ available: true });
  expect(binding.operations.setViewport).toBeTypeOf('function');
  expect(binding.facts.operations.captureScreenshot).toEqual({ available: true });
  expect(binding.operations.captureScreenshot).toBeTypeOf('function');
  // No point-addressed read on the web backend: `get` answers from the captured DOM tree. The
  // legacy `read` dispatch had no web arm at all and threw on every call before falling back.
  expect(binding.facts.operations.readTextAtPoint.available).toBe(false);
  expect(binding.operations.readTextAtPoint).toBeUndefined();
  expect(binding.operations.captureSnapshot).toBeTypeOf('function');
  expectLifecycleFacts(binding);
});

test('keeps a web transport without dumpNetwork unavailable instead of throwing a stub', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.operations.networkDump).toBeUndefined();
  expect(binding.facts.operations.networkDump).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
    hint: 'network is not supported by this web provider',
  });
  expectLifecycleFacts(binding);
});

test('binds agent-browser recording only through the focused web transport', async () => {
  const calls: string[] = [];
  const binding = await createWebPlatformRuntime(
    host(
      { mode: 'local' },
      {
        start: async (outputPath) => {
          calls.push(`start:${outputPath}`);
        },
        stop: async () => {
          calls.push('stop');
        },
      },
    ),
  ).bind({ device, intent: { kind: 'ordinary' }, scope: scope() });
  const started = await binding.operations.screenRecordingStart?.({
    sessionId: 'one',
    outputPath: '/tmp/recording.webm',
    scope: 'app',
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'one', generation: 1 },
  });
  assert.ok(started);
  await started.pendingHandle.transfer().forceCleanup();
  expect(calls).toEqual(['start:/tmp/recording.webm', 'stop']);
  expect(binding.facts.operations.screenRecordingStart).toEqual({ available: true });
  expectLifecycleFacts(binding);
});

test('does not advertise recording without the active agent-browser transport', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'local' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.operations.screenRecordingStart).toBeUndefined();
  expect(binding.facts.operations.screenRecordingStart).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expectLifecycleFacts(binding);
});

test.each([
  { name: 'emulator', device: { ...device, id: 'web-emulator', kind: 'emulator' as const } },
  { name: 'simulator', device: { ...device, id: 'web-simulator', kind: 'simulator' as const } },
])(
  'fails closed for a non-browser web $name instead of inheriting the device lifecycle facet',
  async ({ device: runtimeDevice }) => {
    const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
      device: runtimeDevice,
      intent: { kind: 'ordinary' },
      scope: scope(),
    });
    expectLifecycleFacts(binding, {
      openTarget: false,
      prepareAppleRunner: false,
      closeTarget: false,
      runtimeHints: false,
      portReverse: false,
    });
    expect(binding.facts.operations.captureSnapshot.available).toBe(false);
    expect(binding.facts.operations.setViewport.available).toBe(false);
    expect(binding.operations.setViewport).toBeUndefined();
    expect(binding.facts.operations.captureScreenshot.available).toBe(false);
    expect(binding.operations.captureScreenshot).toBeUndefined();
    expect(binding.operations.captureSnapshot).toBeUndefined();
  },
);

test('binds viewport resizing through the local web interactor and honors cancellation', async () => {
  const setViewport = vi.fn(async () => undefined);
  const runtimeHost = {
    ...host({ mode: 'local' }),
    localInteractors: {
      resolve: async () => ({ setViewport }) as unknown as Interactor,
    },
  };
  const binding = await createWebPlatformRuntime(runtimeHost).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });

  await binding.operations.setViewport?.({ width: 1280, height: 900 });
  expect(setViewport).toHaveBeenCalledTimes(1);
  expect(setViewport).toHaveBeenCalledWith(1280, 900);

  const canceled = new AbortController();
  canceled.abort(new Error('request canceled'));
  const canceledBinding = await createWebPlatformRuntime(runtimeHost).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: { ...scope(), signal: canceled.signal },
  });
  await expect(
    canceledBinding.operations.setViewport?.({ width: 800, height: 600 }),
  ).rejects.toThrow('request canceled');
  expect(setViewport).toHaveBeenCalledTimes(1);
});

type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

function expectLifecycleFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  // Independent legacy descriptor/dispatch cell for web.device. Runtime hints and prepare were
  // never callable web operations, even though open and close share this runtime owner.
  legacy: LegacyLifecycleCell = {
    openTarget: true,
    prepareAppleRunner: false,
    closeTarget: true,
    runtimeHints: false,
    portReverse: false,
  },
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

function input() {
  return {
    sessionId: 'one',
    maxEntries: 25,
    include: 'summary' as const,
    maxPayloadChars: 2048,
    maxScanLines: 4000,
  };
}

function scope() {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

function host(
  transport: Awaited<ReturnType<PlatformRuntimeHost['networkTransports']['resolve']>>,
  webRecording: Awaited<
    ReturnType<PlatformRuntimeHost['screenRecording']['web']['resolve']>
  > = undefined,
): PlatformRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    toolchains: { prepare: async () => {} },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    artifacts: {
      resolveSession: () => ({
        outputPath: '/sessions/one/app.log',
        pidPath: '/sessions/one/app-log.pid',
      }),
    },
    outputs: {
      openAppend: async () => {
        throw new Error('unused');
      },
      readTail: async () => '',
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
    processTransports: { resolve: async () => ({ mode: 'local' }) },
    clock: { now: () => 1, sleep: async () => {} },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: { resolve: async () => transport },
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
      appleAutomation: { keepHot: () => {}, markBooted: () => {} },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    localInteractors: { resolve: async () => ({}) as Interactor },
    applicationResources: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => {},
      finalizeDaemonShutdown: async () => {},
    },
    appleApplications: {} as PlatformRuntimeHost['appleApplications'],
    androidApplications: {} as PlatformRuntimeHost['androidApplications'],
    screenRecording: {
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
      web: { resolve: async () => webRecording },
      finalize: { complete: async () => ({}) },
    },
  } as unknown as PlatformRuntimeHost;
}
