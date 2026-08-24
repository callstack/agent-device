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
  // R40/R41: the browser device drives touch and text through the one web interactor.
  expect(binding.facts.operations.focusPoint).toEqual({ available: true });
  expect(binding.facts.operations.typeText).toEqual({ available: true });
  expect(binding.operations.focusPoint).toBeTypeOf('function');
  expect(binding.operations.typeText).toBeTypeOf('function');
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

test('projects sparse scoped-provider touch methods into facts and bound operations', async () => {
  const sparseInteractor = {
    tap: async () => undefined,
    fill: async () => undefined,
  } as unknown as Interactor;
  const runtime = createWebPlatformRuntime(host({ mode: 'local' }, undefined, sparseInteractor));
  const facts = await runtime.inspectFacts(device);
  const binding = await runtime.bind({ device, intent: { kind: 'ordinary' }, scope: scope() });

  for (const operation of ['tapRef', 'hoverPoint', 'hoverRef', 'fillRef'] as const) {
    expect(facts.operations[operation]).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
  expect(facts.operations.tapPoint).toEqual({ available: true });
  expect(facts.operations.fillPoint).toEqual({ available: true });
  expect(binding.operations.tapPoint).toBeTypeOf('function');
  expect(binding.operations.fillPoint).toBeTypeOf('function');
});

test('binds only the scoped-provider touch methods that are present', async () => {
  const fullInteractor = {
    tap: async () => undefined,
    tapRef: async () => undefined,
    hover: async () => undefined,
    hoverRef: async () => undefined,
    fill: async () => undefined,
    fillRef: async () => undefined,
  } as unknown as Interactor;
  const runtime = createWebPlatformRuntime(host({ mode: 'local' }, undefined, fullInteractor));
  const facts = await runtime.inspectFacts(device);
  const binding = await runtime.bind({ device, intent: { kind: 'ordinary' }, scope: scope() });

  for (const operation of ['tapRef', 'hoverPoint', 'hoverRef', 'fillRef'] as const) {
    expect(facts.operations[operation]).toEqual({ available: true });
    expect(binding.operations[operation]).toBeTypeOf('function');
  }
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
    expect(binding.facts.operations.focusPoint.available).toBe(false);
    expect(binding.operations.focusPoint).toBeUndefined();
    expect(binding.facts.operations.typeText.available).toBe(false);
    expect(binding.operations.typeText).toBeUndefined();
    expect(binding.operations.captureSnapshot).toBeUndefined();
  },
);

test('clipboard, the app switcher, app events, settings and alerts carry no web bucket', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  for (const operation of [
    'readClipboard',
    'writeClipboard',
    'appSwitcher',
    'triggerAppEvent',
    // R58/R59: the retired `settings` and `alert` descriptors declared no web leaf either.
    'setSetting',
    'readAlert',
    'awaitAlert',
    'acceptAlert',
    'dismissAlert',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
});

test('back/home/orientation/tv-remote/keyboard never carried a web capability bucket', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  for (const operation of [
    'back',
    'home',
    'setOrientation',
    'tvRemote',
    'keyboardStatus',
    'keyboardDismiss',
    'keyboardEnter',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
});

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
  interactor: Interactor = {} as Interactor,
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
      appleAutomation: {
        keepHot: () => {},
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    localInteractors: { resolve: async () => interactor },
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

// R52/R53: `scroll` is the one gesture-family command the web overlay ever admitted
// (`WEB_INTERACTION_COMMANDS`); `gesture` and `swipe` carried no web bucket at all, and the
// retired admission refused `platform === 'web'` outright.
test('admits web scrolling and refuses every gesture tier', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'local' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.facts.operations.scrollDirection).toEqual({ available: true });
  expect(binding.operations.scrollDirection).toBeTypeOf('function');
  for (const operation of [
    'performGesturePlan',
    'performDirectionalFlingPlan',
    'performMultiTouchGesturePlan',
    'gestureViewport',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
  // The retired admission checked drag FIRST, before its `platform === 'web'` branch, so this one
  // tier keeps the target-authored-drag wording rather than the bare platform refusal.
  expect(binding.facts.operations.performTargetAuthoredDrag).toMatchObject({
    available: false,
    hint: expect.stringContaining('source hold, timed movement, and destination hold'),
  });
  expect(binding.operations.performTargetAuthoredDrag).toBeUndefined();
});

test('refuses web scrolling on a non-browser web cell', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'local' })).bind({
    device: { ...device, kind: 'emulator' },
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.facts.operations.scrollDirection.available).toBe(false);
  expect(binding.operations.scrollDirection).toBeUndefined();
});

// #1900: `boot`/`bootTargetHeadless` and `shutdown` have no web-specific evidence beyond this
// runtime-owned fact — a managed browser session has no OS-level boot or shutdown to drive.
test('boot and shutdown report the runtime-owned unavailable readiness fact', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  for (const operation of ['bootTarget', 'bootTargetHeadless', 'shutdownTarget'] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
});

// #1900: `install` and `reinstall` both resolve to `deployAppUse`, so one shared fact covers
// both — a managed browser session has no installable native app package.
test('install and reinstall share the runtime-owned unavailable deploy fact', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.facts.operations.deployApp).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  expect(binding.operations.deployApp).toBeUndefined();
});

// #1900: `install-from-source` resolves to `readyMaterializeAndDeployAppUse`, requiring all three
// of these facts; none of them exist for a browser target.
test('install-from-source reports the runtime-owned unavailable materialize and deploy facts', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  for (const operation of [
    'ensureReady',
    'materializeAppSource',
    'deployMaterializedApp',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
});

// #1900: `push` resolves to `readySendPushNotificationUse`, requiring both facts below; a browser
// session has no native push channel to deliver through.
test('push reports the runtime-owned unavailable readiness and push facts', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  for (const operation of ['ensureReady', 'sendPushNotification'] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
});

// #1900: `logs` resolves to `appLogRuntimePlanUses` (three of these five facts: appLogInspect,
// appLogDoctor, appLogStart); the other two, appLogReattach/appLogCleanup, are asserted here too
// since they answer the same "no native app-log channel" question a web target has no route for.
test('logs reports the runtime-owned unavailable app-log facts', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  for (const operation of [
    'appLogInspect',
    'appLogDoctor',
    'appLogStart',
    'appLogReattach',
    'appLogCleanup',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
});

// #1900: `diff` resolves to the exact same `snapshotRuntimePlanUses` as the live `snapshot`
// command, so the admitted fact backing `snapshot` also backs `diff`.
test('diff shares the admitted captureSnapshot fact that live snapshot and diff both require', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.facts.operations.captureSnapshot).toEqual({ available: true });
  expect(binding.operations.captureSnapshot).toBeTypeOf('function');
});

// #1900: `pressRuntimeUses` is literally `clickRuntimeUses` (`platform-runtime-operations.ts`),
// so the admitted fact backing the live `click` command also backs `press`. R61 added a third
// consumer of that same cell: `react-native dismiss-overlay` executes one bound `tapPoint`, so a
// browser admits it and answers truthfully that no React Native overlay is present — the widening
// the retired capability bucket had been hiding.
test('press shares the admitted tapPoint fact that live click, press and react-native require', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.facts.operations.tapPoint).toEqual({ available: true });
  expect(binding.operations.tapPoint).toBeTypeOf('function');
});
