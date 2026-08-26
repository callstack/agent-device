import { expect, test, vi } from 'vitest';
import type { AppleAppDeploymentExecutor } from '@agent-device/contracts/app-deployment-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleAppDeploymentFacts, createAppleAppDeploymentOperations } from './runtime.ts';

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

function deploymentHost(
  appleDeployment: AppleAppDeploymentExecutor,
  run = vi.fn(async (request: { args: readonly string[] }) => ({
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
