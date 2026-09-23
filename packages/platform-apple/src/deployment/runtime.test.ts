import { expect, test, vi } from 'vitest';
import type { AppleAppDeploymentExecutor } from '@agent-device/contracts/app-deployment-runtime';
import type {
  AppleToolRequest,
  HostCommandResult,
} from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { assertRejectsAppError } from '../__tests__/app-error.ts';
import { appleAppDeploymentFacts, createAppleAppDeploymentOperations } from './runtime.ts';

/**
 * Mirrors runXcrun's own contract (host-kit exec.ts): a non-zero exit rejects with the same
 * `execFailureDetails` shape `createExitError` builds — `processExitError: true` plus `cmd` and
 * `args` — and no hint, unless the request set `allowFailure`. A fake that throws a bare
 * COMMAND_FAILED cannot catch a call site that forgot `allowFailure`, or one whose caller drops
 * the stderr excerpt `normalizeError` would otherwise surface (#2785).
 */
function xcrunLikeRun(
  respond: (
    request: AppleToolRequest,
  ) => Readonly<{ stdout: string; stderr: string; exitCode: number }>,
) {
  return vi.fn(async (request: AppleToolRequest): Promise<HostCommandResult> => {
    const result = respond(request);
    if (result.exitCode !== 0 && !request.allowFailure) {
      throw new AppError(
        'COMMAND_FAILED',
        `xcrun exited with code ${result.exitCode}`,
        execFailureDetails(result, { cmd: 'xcrun', args: [request.tool, ...request.args] }),
      );
    }
    return result;
  });
}

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'apple-deployment-fact',
    name: 'Apple',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

async function withoutInvalidatingAppResolutionCache<Result>(
  _device: DeviceInfo,
  operation: () => Promise<Result>,
): Promise<Result> {
  return await operation();
}

function bootedSimulatorListResult(
  request: AppleToolRequest,
): Readonly<{ stdout: string; stderr: string; exitCode: number }> {
  return {
    stdout: request.args.includes('list')
      ? '{"devices":{"runtime":[{"udid":"apple-deployment-fact","state":"Booted"}]}}'
      : '',
    stderr: '',
    exitCode: 0,
  };
}

function deploymentHost(
  appleDeployment: AppleAppDeploymentExecutor,
  run = xcrunLikeRun((request) => ({
    stdout: request.args.includes('list')
      ? '{"devices":{"runtime":[{"udid":"apple-deployment-fact","state":"Booted"}]}}'
      : '',
    stderr: '',
    exitCode: 0,
  })),
): PlatformRuntimeHost {
  return {
    appleDeployment,
    appleTools: { isXcrunAvailable: async () => true, run },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    temporaryFiles: {
      create: async ({ suffix }: { suffix: string }) => ({
        path: `/tmp/value${suffix}`,
        readText: async () => '',
        writeText: async () => {},
        [Symbol.asyncDispose]: async () => {},
      }),
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
  } as unknown as PlatformRuntimeHost;
}

test.each([
  ['iOS simulator', appleDevice(), true, true, undefined],
  ['legacy unstamped iOS simulator', appleDevice({ appleOs: undefined }), true, true, undefined],
  [
    'iOS CoreDevice physical device',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'iOS XCTest physical device',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    false,
    'unsupported-device-backend',
  ],
  ['iPadOS simulator', appleDevice({ appleOs: 'ipados' }), true, true, undefined],
  [
    'iPadOS CoreDevice physical device',
    appleDevice({ appleOs: 'ipados', kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'iPadOS XCTest physical device',
    appleDevice({ appleOs: 'ipados', kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    false,
    'unsupported-device-backend',
  ],
  ['tvOS simulator', appleDevice({ appleOs: 'tvos', target: 'tv' }), true, true, undefined],
  [
    'tvOS CoreDevice physical device',
    appleDevice({
      appleOs: 'tvos',
      kind: 'device',
      target: 'tv',
      iosPhysicalDeviceBackend: 'coredevice',
    }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'tvOS XCTest physical device',
    appleDevice({
      appleOs: 'tvos',
      kind: 'device',
      target: 'tv',
      iosPhysicalDeviceBackend: 'xctest',
    }),
    false,
    false,
    'unsupported-device-backend',
  ],
  ['visionOS simulator', appleDevice({ appleOs: 'visionos' }), true, true, undefined],
  [
    'visionOS CoreDevice physical device',
    appleDevice({ appleOs: 'visionos', kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    false,
    'unsupported-device-kind',
  ],
  [
    'visionOS XCTest physical device',
    appleDevice({ appleOs: 'visionos', kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    false,
    'unsupported-device-backend',
  ],
  [
    'macOS host',
    appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'macOS simulator sentinel',
    appleDevice({ appleOs: 'macos', kind: 'simulator', target: 'desktop' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'watchOS sentinel',
    appleDevice({ appleOs: 'watchos' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'watchOS physical sentinel',
    appleDevice({ appleOs: 'watchos', kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    false,
    false,
    'unsupported-platform-leaf',
  ],
  [
    'invalid Apple emulator kind',
    appleDevice({ kind: 'emulator' }),
    false,
    false,
    'unsupported-device-kind',
  ],
] as const)(
  'classifies deployment facts for the %s denominator cell',
  (_name, device, deployAvailable, pushAvailable, unavailableReason) => {
    const facts = appleAppDeploymentFacts(device);
    for (const operation of [
      facts.deployApp,
      facts.materializeAppSource,
      facts.deployMaterializedApp,
    ]) {
      expect(operation.available).toBe(deployAvailable);
    }
    expect(facts.sendPushNotification.available).toBe(pushAvailable);
    if (unavailableReason) {
      expect(deployAvailable ? facts.sendPushNotification : facts.deployApp).toMatchObject({
        reason: unavailableReason,
      });
    }
    if (device.iosPhysicalDeviceBackend === 'xctest') {
      expect(facts.deployApp).toMatchObject({ hint: expect.stringContaining('CoreDevice-backed') });
    }
  },
);

test('exposes only fact-admitted Apple deployment operations', async () => {
  const cleanup = vi.fn(async () => {});
  const prepareArtifact = vi.fn(async () => ({
    installablePath: '/tmp/App.app',
    bundleId: 'com.example.app',
    appName: 'Example',
    cleanup,
  }));
  const resolveAppBundleId = vi.fn(async () => 'com.example.replaced');
  const executor = {
    prepareArtifact,
    resolveAppBundleId,
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const run = vi.fn(async (request: { args: readonly string[] }) => ({
    stdout: request.args.includes('list')
      ? '{"devices":{"runtime":[{"udid":"apple-deployment-fact","state":"Booted"}]}}'
      : '',
    stderr: '',
    exitCode: 0,
  }));
  const host = deploymentHost(executor, run);
  const device = appleDevice();
  const signal = new AbortController().signal;
  const operations = createAppleAppDeploymentOperations({
    host,
    device,
    signal,
  });

  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/App.app',
    replaceExisting: false,
  });
  const artifact = await operations.materializeAppSource?.({
    source: { kind: 'path', path: '/tmp/App.app' },
  });
  await operations.deployMaterializedApp?.({ artifact: artifact! });
  await operations.sendPushNotification?.({ appId: 'com.example.app', payload: {} });
  await operations.deployApp?.({
    app: 'com.example.replaced',
    appPath: '/tmp/App.app',
    replaceExisting: true,
  });

  expect(prepareArtifact).toHaveBeenCalledTimes(3);
  expect(run.mock.calls.filter(([request]) => request.args.includes('install'))).toHaveLength(3);
  expect(run.mock.calls.filter(([request]) => request.args.includes('uninstall'))).toHaveLength(1);
  expect(run.mock.calls.filter(([request]) => request.args.includes('push'))).toHaveLength(1);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(resolveAppBundleId).toHaveBeenCalledWith(device, 'com.example.replaced');
  expect(prepareArtifact).toHaveBeenNthCalledWith(
    1,
    { source: { kind: 'path', path: '/tmp/App.app' } },
    expect.objectContaining({ appIdentifierHint: 'com.example.app' }),
  );
  expect(prepareArtifact).toHaveBeenNthCalledWith(
    2,
    { source: { kind: 'path', path: '/tmp/App.app' } },
    expect.not.objectContaining({ appIdentifierHint: expect.anything() }),
  );
  expect(
    createAppleAppDeploymentOperations({
      host,
      device: appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
      signal: new AbortController().signal,
    }),
  ).toEqual({});
});

test('physical iOS install failure surfaces the devicectl Developer Mode hint', async () => {
  const prepareArtifact = vi.fn(async () => ({
    installablePath: '/tmp/App.app',
    bundleId: 'com.example.app',
    appName: 'Example',
    cleanup: vi.fn(async () => {}),
  }));
  const executor = {
    prepareArtifact,
    resolveAppBundleId: vi.fn(),
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const run = xcrunLikeRun((request) =>
    request.args.includes('install')
      ? {
          stdout: '',
          stderr: 'Unable to install "com.example.app": Developer Mode is disabled on this device.',
          exitCode: 1,
        }
      : { stdout: '', stderr: '', exitCode: 0 },
  );
  const host = deploymentHost(executor, run);
  const device = appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' });
  const operations = createAppleAppDeploymentOperations({
    host,
    device,
    signal: new AbortController().signal,
  });

  await assertRejectsAppError(
    async () =>
      await operations.deployApp?.({
        app: 'com.example.app',
        appPath: '/tmp/App.app',
        replaceExisting: false,
      }),
    {
      code: 'COMMAND_FAILED',
      hint: /Developer Mode/,
      normalizedMessage: /Developer Mode is disabled on this device/,
    },
  );
  expect(run.mock.calls.some(([request]) => request.args.includes('install'))).toBe(true);
});

test('simulator install failure surfaces the simctl stderr excerpt with no devicectl hint', async () => {
  const prepareArtifact = vi.fn(async () => ({
    installablePath: '/tmp/App.app',
    bundleId: 'com.example.app',
    appName: 'Example',
    cleanup: vi.fn(async () => {}),
  }));
  const executor = {
    prepareArtifact,
    resolveAppBundleId: vi.fn(),
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const run = xcrunLikeRun((request) =>
    request.args.includes('install')
      ? {
          stdout: '',
          stderr: 'Failed to install the requested application',
          exitCode: 1,
        }
      : bootedSimulatorListResult(request),
  );
  const host = deploymentHost(executor, run);
  const device = appleDevice();
  const operations = createAppleAppDeploymentOperations({
    host,
    device,
    signal: new AbortController().signal,
  });

  await assertRejectsAppError(
    async () =>
      await operations.deployApp?.({
        app: 'com.example.app',
        appPath: '/tmp/App.app',
        replaceExisting: false,
      }),
    {
      code: 'COMMAND_FAILED',
      normalizedMessage: /Failed to install the requested application/,
    },
  );
  const [request] = run.mock.calls.find(([call]) => call.args.includes('install'))!;
  expect(request.allowFailure).toBe(true);
});

test('simulator push failure surfaces the simctl stderr excerpt', async () => {
  const executor = {
    prepareArtifact: vi.fn(),
    resolveAppBundleId: vi.fn(),
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const run = xcrunLikeRun((request) =>
    request.args.includes('push')
      ? {
          stdout: '',
          stderr: 'Invalid device state: Booted',
          exitCode: 1,
        }
      : bootedSimulatorListResult(request),
  );
  const host = deploymentHost(executor, run);
  const device = appleDevice();
  const operations = createAppleAppDeploymentOperations({
    host,
    device,
    signal: new AbortController().signal,
  });

  await assertRejectsAppError(
    async () => await operations.sendPushNotification?.({ appId: 'com.example.app', payload: {} }),
    {
      code: 'COMMAND_FAILED',
      normalizedMessage: /Invalid device state: Booted/,
    },
  );
  const [request] = run.mock.calls.find(([call]) => call.args.includes('push'))!;
  expect(request.allowFailure).toBe(true);
});

test('physical iOS uninstall failure surfaces the devicectl Developer Mode hint', async () => {
  const resolveAppBundleId = vi.fn(async () => 'com.example.app');
  const executor = {
    prepareArtifact: vi.fn(),
    resolveAppBundleId,
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const run = xcrunLikeRun((request) =>
    request.args.includes('uninstall')
      ? {
          stdout: '',
          stderr:
            'Unable to uninstall "com.example.app": Developer Mode is disabled on this device.',
          exitCode: 1,
        }
      : { stdout: '', stderr: '', exitCode: 0 },
  );
  const host = deploymentHost(executor, run);
  const device = appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' });
  const operations = createAppleAppDeploymentOperations({
    host,
    device,
    signal: new AbortController().signal,
  });

  await assertRejectsAppError(
    async () =>
      await operations.deployApp?.({
        app: 'com.example.app',
        appPath: '/tmp/replacement.app',
        replaceExisting: true,
      }),
    {
      code: 'COMMAND_FAILED',
      hint: /Developer Mode/,
      normalizedMessage: /Developer Mode is disabled on this device/,
    },
  );
  expect(run.mock.calls.some(([request]) => request.args.includes('uninstall'))).toBe(true);
});

test.each([
  [
    'physical iOS CoreDevice',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
  ],
  ['iOS simulator', appleDevice()],
] as const)(
  'reinstall tolerates an already-missing %s uninstall with mixed-case stderr and still installs',
  async (_name, device) => {
    const resolveAppBundleId = vi.fn(async () => 'com.example.app');
    const prepareArtifact = vi.fn(async () => ({
      installablePath: '/tmp/App.app',
      bundleId: 'com.example.app',
      appName: 'Example',
      cleanup: vi.fn(async () => {}),
    }));
    const executor = {
      prepareArtifact,
      resolveAppBundleId,
      withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
    } as AppleAppDeploymentExecutor;
    const run = xcrunLikeRun((request) => {
      if (request.args.includes('uninstall')) {
        return { stdout: '', stderr: 'ERROR: App Not Installed', exitCode: 1 };
      }
      return bootedSimulatorListResult(request);
    });
    const host = deploymentHost(executor, run);
    const operations = createAppleAppDeploymentOperations({
      host,
      device,
      signal: new AbortController().signal,
    });

    await expect(
      operations.deployApp?.({
        app: 'com.example.app',
        appPath: '/tmp/App.app',
        replaceExisting: true,
      }),
    ).resolves.toMatchObject({ bundleId: 'com.example.app' });

    expect(run.mock.calls.some(([request]) => request.args.includes('uninstall'))).toBe(true);
    expect(run.mock.calls.some(([request]) => request.args.includes('install'))).toBe(true);
  },
);

test('preserves Apple reinstall partial-failure ordering', async () => {
  const order: string[] = [];
  const resolveAppBundleId = vi.fn(async () => {
    order.push('uninstall');
    return 'com.example.replaced';
  });
  const prepareArtifact = vi.fn(async () => {
    order.push('prepare');
    throw new Error('replacement artifact is invalid');
  });
  const executor = {
    prepareArtifact,
    resolveAppBundleId,
    withInvalidatedAppResolutionCache: withoutInvalidatingAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const host = deploymentHost(executor);
  const operations = createAppleAppDeploymentOperations({
    host,
    device: appleDevice(),
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({
      app: 'com.example.replaced',
      appPath: '/tmp/replacement.app',
      replaceExisting: true,
    }),
  ).rejects.toThrow('replacement artifact is invalid');

  expect(order).toEqual(['uninstall', 'prepare']);
});

test('clears a concurrently repopulated fuzzy resolution after a partial-failed Apple reinstall', async () => {
  const cachedResolutions = new Map([['Maps', 'com.example.stale-before-uninstall']]);
  let nextResolution = 'com.example.current';
  const resolveFuzzyTarget = vi.fn(async (target: string) => {
    const resolved = cachedResolutions.get(target) ?? nextResolution;
    cachedResolutions.set(target, resolved);
    return resolved;
  });
  const invalidateDuringUninstall = async <Result>(operation: () => Promise<Result>) => {
    cachedResolutions.clear();
    try {
      return await operation();
    } finally {
      cachedResolutions.clear();
    }
  };
  const resolveAppBundleId = vi.fn(
    async (_device: DeviceInfo, app: string) =>
      await invalidateDuringUninstall(async () => {
        const bundleId = await resolveFuzzyTarget(app);
        expect(bundleId).toBe('com.example.current');
        return bundleId;
      }),
  );
  const prepareArtifact = vi.fn(async () => {
    const repopulate = Promise.resolve().then(async () => {
      nextResolution = 'com.example.stale-after-uninstall';
      await resolveFuzzyTarget('Maps');
    });
    await repopulate;
    throw new Error('replacement artifact is invalid');
  });
  const withInvalidatedAppResolutionCache = vi.fn(
    async <Result>(_device: DeviceInfo, operation: () => Promise<Result>): Promise<Result> => {
      cachedResolutions.clear();
      try {
        return await operation();
      } finally {
        cachedResolutions.clear();
      }
    },
  );
  const executor = {
    prepareArtifact,
    resolveAppBundleId,
    withInvalidatedAppResolutionCache,
  } as AppleAppDeploymentExecutor;
  const operations = createAppleAppDeploymentOperations({
    host: deploymentHost(executor),
    device: appleDevice(),
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({
      app: 'Maps',
      appPath: '/tmp/replacement.app',
      replaceExisting: true,
    }),
  ).rejects.toThrow('replacement artifact is invalid');

  // The low-level uninstall scope clears its own cache, but a resolution racing artifact
  // preparation can repopulate it. The whole reinstall scope must clear that stale value even
  // when preparation fails before any install attempt.
  expect(cachedResolutions).toEqual(new Map());
  expect(withInvalidatedAppResolutionCache).toHaveBeenCalledOnce();
  expect(resolveFuzzyTarget).toHaveBeenCalledTimes(2);
});
