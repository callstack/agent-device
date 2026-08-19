import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import { providerRuntimeOwner } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor } from '@agent-device/contracts/interaction';
import { createWebDriverPlatformRuntimeOwner } from './platform-runtime.ts';

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
  // Provider ownership is authoritative and fails closed: a WebDriver owner's transport carries
  // no local point-read tool, so it advertises none and never borrows the local family read.
  expect(binding.facts.operations.readTextAtPoint).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(binding.operations.readTextAtPoint).toBeUndefined();
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
    ...state,
    getInteractor,
  });
  const facts = await owner.inspectFacts(device);
  expect(facts.operations.captureSnapshot.available).toBe(false);
  expect(facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
  expect(facts.operations.captureSnapshotWithoutActiveApp.available).toBe(false);
  expect(facts.operations.setViewport.available).toBe(false);
  expect(facts.operations.captureScreenshot.available).toBe(false);
  expect(facts.operations.readTextAtPoint.available).toBe(false);
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
      appleAutomation: { keepHot: () => {} },
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
