import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { createWebDriverPlatformRuntimeOwner } from './platform-runtime.ts';
import {
  createCloudWebDriverCapabilities,
  type CloudWebDriverCapabilityOverrides,
} from './capabilities.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

/** The declared map fact generation now reads. Defaults to a provider with no overrides. */
function capabilities(
  platform: CloudWebDriverPlatform = 'android',
  overrides?: CloudWebDriverCapabilityOverrides,
) {
  return createCloudWebDriverCapabilities({
    provider: 'browserstack',
    platform,
    ...(overrides ? { overrides } : {}),
  });
}

const device: DeviceInfo = {
  platform: 'android',
  id: 'browserstack:lease-one',
  name: 'Remote Android',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

test('direct WebDriver network uses only the canonical session log and preserves empty success', async () => {
  const run = vi.fn(async () => ({ stdout: 'must not execute', stderr: '', exitCode: 0 }));
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(run),
    owner: providerRuntimeOwner('browserstack', 'android'),
    ownsDevice: () => true,
    capabilities: capabilities(),
  });
  const binding = await owner.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await expect(
    binding.operations.networkDump?.({
      sessionId: 'one',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 4000,
    }),
  ).resolves.toMatchObject({
    source: 'app-log',
    backend: 'android',
    dump: { exists: false, entries: [] },
  });
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
  expect(binding.facts.operations.appLogInspect).toMatchObject({ available: false });
  for (const operation of [
    'deployApp',
    'materializeAppSource',
    'deployMaterializedApp',
    'sendPushNotification',
  ] as const) {
    expect(binding.facts.operations[operation]).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
  }
  expect(binding.operations.deployApp).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

test.each([
  ['Android', device, 'android'],
  [
    'iOS',
    {
      ...device,
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'browserstack:ios:lease-one',
      name: 'Remote iPhone',
    },
    'ios-device',
  ],
])('classifies the direct WebDriver %s network cell', async (_name, runtimeDevice, backend) => {
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    owner: providerRuntimeOwner('browserstack', String(_name).toLowerCase()),
    ownsDevice: () => true,
    capabilities: capabilities(),
  });
  const binding = await owner.bind({
    device: runtimeDevice,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  expect(binding.facts.device.providerMode).toBe('provider-runtime');
  expect(binding.facts.operations.appState).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
  expect(binding.facts.operations.ensureReady).toEqual({ available: true });
  expect(binding.facts.operations.bootTarget).toEqual({ available: true });
  expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
  expect(binding.facts.operations.listApps).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  await expect(binding.operations.ensureReady?.({})).resolves.toMatchObject({
    id: runtimeDevice.id,
    booted: true,
  });
  await expect(binding.operations.bootTarget?.({})).resolves.toMatchObject({
    id: runtimeDevice.id,
    booted: true,
  });
  await expect(
    binding.operations.networkDump?.({
      sessionId: 'one',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 4000,
    }),
  ).resolves.toMatchObject({ source: 'app-log', backend });
});

test.each([
  ['Android', device],
  [
    'iOS',
    {
      ...device,
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'browserstack:ios:lease-one',
      name: 'Remote iPhone',
    },
  ],
] as const)(
  'uses an admitted direct WebDriver deployment runtime for %s without a local fallback',
  async (_name, runtimeDevice) => {
    const deployApp = vi.fn(async () => ({ launchTarget: 'provider-installed' }));
    const deployMaterializedApp = vi.fn(async () => ({ launchTarget: 'provider-materialized' }));
    const materializeApple = vi.fn(async () => ({
      installablePath: '/tmp/App.app',
      cleanup: async () => {},
    }));
    const materializeAndroid = vi.fn(async () => ({
      installablePath: '/tmp/app.apk',
      cleanup: async () => {},
    }));
    const base = host(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const owner = createWebDriverPlatformRuntimeOwner({
      host: {
        ...base,
        appleDeployment: {
          prepareArtifact: materializeApple,
        } as unknown as PlatformRuntimeHost['appleDeployment'],
        androidDeployment: {
          prepareArtifact: materializeAndroid,
        } as unknown as PlatformRuntimeHost['androidDeployment'],
      },
      owner: providerRuntimeOwner(
        'browserstack',
        runtimeDevice.platform === 'apple' ? 'ios' : 'android',
      ),
      ownsDevice: () => true,
      capabilities: capabilities(),
      deployment: {
        fact: () => ({ available: true }),
        deployApp,
        deployMaterializedApp,
      },
    });
    const controller = new AbortController();
    const binding = await owner.bind({
      device: runtimeDevice,
      intent: { kind: 'ordinary' },
      scope: {
        signal: controller.signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });

    for (const operation of [
      'deployApp',
      'materializeAppSource',
      'deployMaterializedApp',
    ] as const) {
      expect(binding.facts.operations[operation]).toEqual({ available: true });
    }
    expect(binding.facts.operations.sendPushNotification).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
    const deployInput = {
      app: 'com.example.app',
      appPath: '/tmp/app',
      replaceExisting: false,
    };
    await binding.operations.deployApp?.(deployInput);
    const artifact = await binding.operations.materializeAppSource?.({
      source: { kind: 'path', path: '/tmp/app' },
    });
    const materializedInput = { artifact: artifact! };
    await binding.operations.deployMaterializedApp?.(materializedInput);
    expect(deployApp).toHaveBeenCalledWith(runtimeDevice, deployInput, controller.signal);
    expect(deployMaterializedApp).toHaveBeenCalledWith(
      runtimeDevice,
      materializedInput,
      controller.signal,
    );
    expect(materializeApple).toHaveBeenCalledTimes(runtimeDevice.platform === 'apple' ? 1 : 0);
    expect(materializeAndroid).toHaveBeenCalledTimes(runtimeDevice.platform === 'android' ? 1 : 0);
  },
);

test('captures through only the active exact WebDriver interactor', async () => {
  const snapshot = vi.fn(async () => ({ backend: 'android' as const, nodes: [] }));
  const getInteractor = vi.fn(() => ({ snapshot }) as unknown as Interactor);
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    owner: providerRuntimeOwner('browserstack', 'android'),
    ownsDevice: () => true,
    capabilities: capabilities(),
    snapshotAvailable: true,
    getInteractor,
  });
  const binding = await owner.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  expect(binding.facts.operations.captureSnapshot).toEqual({ available: true });
  expect(binding.facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
  expect(binding.facts.operations.captureSnapshotWithoutActiveApp).toEqual({ available: true });
  expect(binding.facts.operations.setViewport).toMatchObject({ available: false });
  expect(binding.operations.setViewport).toBeUndefined();
  expect(binding.facts.operations.captureScreenshot).toEqual({ available: true });
  expect(binding.operations.captureScreenshot).toBeTypeOf('function');
  // R40/R41: interaction cells share the captures' reachability gate and interactor.
  expect(binding.facts.operations.focusPoint).toEqual({ available: true });
  expect(binding.facts.operations.typeText).toEqual({ available: true });
  expect(binding.operations.focusPoint).toBeTypeOf('function');
  expect(binding.operations.typeText).toBeTypeOf('function');
  // Provider ownership is authoritative and fails closed: a WebDriver owner's transport carries
  // no local point-read tool, so it advertises none and never borrows the local family read.
  expect(binding.facts.operations.readTextAtPoint).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(binding.operations.readTextAtPoint).toBeUndefined();
  // back/home/orientation and both clipboard halves ride the same reachable interactor
  // focus/type do; the declared-capability gate stays inside the interactor.
  for (const operation of [
    'back',
    'home',
    'setOrientation',
    'readClipboard',
    'writeClipboard',
    'appSwitcher',
    'triggerAppEvent',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({ available: true });
    expect(binding.operations[operation]).toBeTypeOf('function');
  }
  // tv-remote, settings, and every keyboard action always throw unsupported in this interactor
  // regardless of reachability: no capability ever declared them.
  for (const operation of [
    'tvRemote',
    'setSetting',
    'readAlert',
    'awaitAlert',
    'acceptAlert',
    'dismissAlert',
    'keyboardStatus',
    'keyboardDismiss',
    'keyboardEnter',
  ] as const) {
    expect(binding.facts.operations[operation]).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
  await expect(
    binding.operations.captureSnapshot?.({ options: { interactiveOnly: true } }),
  ).resolves.toEqual({ backend: 'android', nodes: [] });
  expect(getInteractor).toHaveBeenCalledWith(device, expect.any(Object));
  expect(snapshot).toHaveBeenCalledWith({
    interactiveOnly: true,
    signal: expect.any(AbortSignal),
  });
});

test.each([
  [
    'inactive session',
    { isSessionActive: () => false, snapshotAvailable: true, screenshotAvailable: true },
  ],
  [
    'unsupported capability',
    { isSessionActive: () => true, snapshotAvailable: false, screenshotAvailable: false },
  ],
] as const)('fails closed for an %s capture owner cell', async (_name, state) => {
  const getInteractor = vi.fn(() => ({}) as unknown as Interactor);
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    owner: providerRuntimeOwner('browserstack', 'android'),
    ownsDevice: () => true,
    capabilities: capabilities(),
    ...state,
    getInteractor,
  });
  const facts = await owner.inspectFacts(device);
  expect(facts.operations.captureSnapshot.available).toBe(false);
  expect(facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
  expect(facts.operations.captureSnapshotWithoutActiveApp.available).toBe(false);
  expect(facts.operations.setViewport.available).toBe(false);
  expect(facts.operations.captureScreenshot.available).toBe(false);
  // R40/R41: interaction cells gate on interactor reachability, not on the capture
  // capability declarations — a provider that can drive its interactor can touch and type
  // even when it declares no snapshot/screenshot. Only a dead session closes them.
  expect(facts.operations.focusPoint.available).toBe(state.isSessionActive());
  expect(facts.operations.typeText.available).toBe(state.isSessionActive());
  expect(facts.operations.readTextAtPoint.available).toBe(false);
  // back/home/orientation share focus/type's reachability gate; tv-remote and every keyboard
  // action stay unavailable even for an active session with no reachable interactor.
  expect(facts.operations.back.available).toBe(state.isSessionActive());
  expect(facts.operations.home.available).toBe(state.isSessionActive());
  expect(facts.operations.setOrientation.available).toBe(state.isSessionActive());
  expect(facts.operations.readClipboard.available).toBe(state.isSessionActive());
  expect(facts.operations.writeClipboard.available).toBe(state.isSessionActive());
  expect(facts.operations.appSwitcher.available).toBe(state.isSessionActive());
  expect(facts.operations.triggerAppEvent.available).toBe(state.isSessionActive());
  for (const operation of [
    'tvRemote',
    'setSetting',
    'readAlert',
    'awaitAlert',
    'acceptAlert',
    'dismissAlert',
    'keyboardStatus',
    'keyboardDismiss',
    'keyboardEnter',
  ] as const) {
    expect(facts.operations[operation].available).toBe(false);
  }
  if (state.isSessionActive()) {
    const binding = await owner.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    expect(binding.operations.captureSnapshot).toBeUndefined();
  } else {
    await expect(
      owner.bind({
        device,
        intent: { kind: 'ordinary' },
        scope: {
          signal: new AbortController().signal,
          diagnostics: { emit: () => {} },
          progress: { report: () => {} },
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  }
  expect(getInteractor).not.toHaveBeenCalled();
});

function host(run: PlatformRuntimeHost['commands']['run']): PlatformRuntimeHost {
  // This suite reaches direct network and the explicitly replaced materializer only.
  return {
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: {
        keepHot: () => {},
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
    deviceShutdown: {
      apple: {
        shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      },
      android: {
        shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      },
    },
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    toolchains: { prepare: async () => {} },
    commands: { which: async () => undefined, run },
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
    snapshot: {
      captureSurface: async () => ({
        backend: 'xctest' as const,
        producer: 'appium-source' as const,
        nodes: [],
      }),
      presentIosAcquisition: async () => ({
        backend: 'xctest' as const,
        producer: 'appium-source' as const,
        nodes: [],
      }),
    },
    networkTransports: { resolve: async () => ({ mode: 'local' }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
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
      web: { resolve: async () => undefined },
      finalize: { complete: async () => ({}) },
    },
  } as unknown as PlatformRuntimeHost;
}

// R52/R53: gestures and scrolling ride the same reachability gate the captures do. The one extra
// gate is the retired multi-touch policy — this provider owns physical devices only, and
// two-finger synthesis on a physical iOS device was refused before this migration too.
test.each([
  ['Android physical', device, true],
  ['iOS physical', { ...device, platform: 'apple' as const, appleOs: 'ios' as const }, false],
])('declares the WebDriver %s gesture and scroll cells', async (_name, owned, multiTouch) => {
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    owner: providerRuntimeOwner('browserstack', 'android'),
    ownsDevice: () => true,
    capabilities: capabilities(),
    getInteractor: () => ({}) as unknown as Interactor,
  });
  const facts = await owner.inspectFacts(owned);
  expect(facts.operations.performGesturePlan).toEqual({ available: true });
  expect(facts.operations.performDirectionalFlingPlan).toEqual({ available: true });
  expect(facts.operations.performTargetAuthoredDrag).toEqual({ available: true });
  expect(facts.operations.gestureViewport).toEqual({ available: true });
  expect(facts.operations.scrollDirection).toEqual({ available: true });
  expect(facts.operations.performMultiTouchGesturePlan.available).toBe(multiTouch);
  if (!multiTouch) {
    expect(facts.operations.performMultiTouchGesturePlan).toMatchObject({
      hint: 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.',
    });
  }
});

test('closes every WebDriver gesture and scroll cell when the interactor is unreachable', async () => {
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    owner: providerRuntimeOwner('browserstack', 'android'),
    ownsDevice: () => true,
    capabilities: capabilities(),
    getInteractor: undefined,
  });
  const facts = await owner.inspectFacts(device);
  for (const operation of [
    'performGesturePlan',
    'performDirectionalFlingPlan',
    'performMultiTouchGesturePlan',
    'performTargetAuthoredDrag',
    'gestureViewport',
    'scrollDirection',
  ] as const) {
    expect(facts.operations[operation]).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
  }
});

// The defect this pins: a provider configured with `capabilityOverrides` used to be admitted from
// interactor reachability alone, so `capabilities` advertised the operation and the interactor's
// own `requireSupport` threw `UNSUPPORTED_OPERATION` after binding. Admission and execution now
// read the same declared map (ADR 0019 §2).
test.each([
  ['clipboard.read', 'readClipboard'],
  ['clipboard.write', 'writeClipboard'],
  ['appSwitcher', 'appSwitcher'],
  ['back', 'back'],
  ['home', 'home'],
  ['orientation', 'setOrientation'],
] as const)(
  'an unsupported %s override is refused at admission, not after binding',
  async (operation, factKey) => {
    const owner = createWebDriverPlatformRuntimeOwner({
      host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      owner: providerRuntimeOwner('browserstack', 'android'),
      ownsDevice: () => true,
      capabilities: capabilities('android', { [operation]: 'unsupported' }),
      getInteractor: () => ({}) as unknown as Interactor,
    });

    const facts = await owner.inspectFacts(device);

    expect(facts.operations[factKey]).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
    // The refusal carries the capability map author's own wording.
    const fact = facts.operations[factKey];
    expect(fact.available === false && String(fact.hint)).toContain(operation);
  },
);

test('a reachable provider with no overrides still admits its declared operations', async () => {
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    owner: providerRuntimeOwner('browserstack', 'android'),
    ownsDevice: () => true,
    capabilities: capabilities(),
    getInteractor: () => ({}) as unknown as Interactor,
  });

  const facts = await owner.inspectFacts(device);

  // `partial` counts as supported, matching `capabilitySupported` in the interactor.
  for (const key of ['readClipboard', 'writeClipboard', 'appSwitcher', 'back', 'home'] as const) {
    expect(facts.operations[key].available).toBe(true);
  }
});
