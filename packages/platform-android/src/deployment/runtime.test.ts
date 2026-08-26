import { beforeEach, expect, test, vi } from 'vitest';
import type { AndroidAppDeploymentExecutor } from '@agent-device/contracts/app-deployment-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';

const native = vi.hoisted(() => ({
  installAndroidArtifact: vi.fn(),
  uninstallAndroidPackage: vi.fn(),
  pushAndroidNotification: vi.fn(),
  inferAndroidAppName: vi.fn((packageName: string) => packageName.split('.').at(-1) ?? packageName),
}));
const ensureAndroidReady = vi.hoisted(() => vi.fn());

vi.mock('./native.ts', () => native);
vi.mock('../readiness/runtime.ts', () => ({ ensureAndroidReady }));

import { androidAppDeploymentFacts, createAndroidAppDeploymentOperations } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'android-deployment-fact',
  name: 'Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function hostFixture(overrides: Partial<AndroidAppDeploymentExecutor> = {}): PlatformRuntimeHost {
  const androidDeployment: AndroidAppDeploymentExecutor = {
    withInvalidatedAppResolutionCache: async (_device, operation) => await operation(),
    prepareArtifact: async () => ({
      installablePath: '/tmp/app.apk',
      packageName: 'com.example.app',
      cleanup: async () => {},
    }),
    resolveAppPackage: async (_device, app) => app,
    ...overrides,
  };
  return { androidDeployment } as unknown as PlatformRuntimeHost;
}

test.each([
  ['emulator', device, true],
  ['physical device', { ...device, kind: 'device' as const }, true],
  ['invalid simulator kind', { ...device, kind: 'simulator' as const }, false],
] as const)(
  'classifies Android deployment facts for the %s denominator cell',
  (_name, runtimeDevice, available) => {
    for (const fact of Object.values(androidAppDeploymentFacts(runtimeDevice))) {
      expect(fact.available).toBe(available);
      if (!available) expect(fact).toMatchObject({ reason: 'unsupported-device-kind' });
    }
  },
);

test('exposes the complete Android deployment operation set only for admitted kinds', async () => {
  const cleanup = vi.fn(async () => {});
  const prepareArtifact = vi.fn(async () => ({
    installablePath: '/tmp/app.apk',
    packageName: 'com.example.app',
    cleanup,
  }));
  const resolveAppPackage = vi.fn(async () => 'com.example.replaced');
  native.installAndroidArtifact.mockResolvedValue('com.example.app');
  native.pushAndroidNotification.mockResolvedValue({ action: 'test', extrasCount: 0 });
  const host = hostFixture({ prepareArtifact, resolveAppPackage });
  const signal = new AbortController().signal;
  const operations = createAndroidAppDeploymentOperations({ host, device, signal });

  await operations.deployApp?.({ app: '', appPath: '/tmp/app.apk', replaceExisting: false });
  const artifact = await operations.materializeAppSource?.({
    source: { kind: 'path', path: '/tmp/app.apk' },
  });
  await operations.deployMaterializedApp?.({ artifact: artifact! });
  await operations.sendPushNotification?.({ appId: 'com.example.app', payload: {} });
  await operations.deployApp?.({
    app: 'com.example.replaced',
    appPath: '/tmp/app.apk',
    replaceExisting: true,
  });

  expect(prepareArtifact).toHaveBeenCalledTimes(3);
  expect(native.installAndroidArtifact).toHaveBeenCalledTimes(3);
  expect(native.uninstallAndroidPackage).toHaveBeenCalledWith(
    host,
    device,
    'com.example.replaced',
    signal,
  );
  expect(native.pushAndroidNotification).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(
    createAndroidAppDeploymentOperations({
      host,
      device: { ...device, kind: 'simulator' },
      signal,
    }),
  ).toEqual({});
});

test('waits for Android readiness before inspecting an install artifact', async () => {
  const order: string[] = [];
  ensureAndroidReady.mockImplementationOnce(async () => {
    order.push('ready');
    return device;
  });
  const host = hostFixture({
    prepareArtifact: async () => {
      order.push('prepare');
      return { installablePath: '/tmp/app.apk', cleanup: async () => {} };
    },
  });
  native.installAndroidArtifact.mockResolvedValueOnce(undefined);

  await createAndroidAppDeploymentOperations({
    host,
    device: { ...device, booted: false },
    signal: new AbortController().signal,
  }).deployApp?.({ app: '', appPath: '/tmp/app.apk', replaceExisting: false });

  expect(ensureAndroidReady).toHaveBeenCalledWith(
    host,
    { ...device, booted: false },
    { headless: false },
    expect.any(AbortSignal),
  );
  expect(order).toEqual(['ready', 'prepare']);
});

test('preserves reinstall partial-failure ordering and whole-operation cache invalidation', async () => {
  const order: string[] = [];
  const cacheCalls: DeviceInfo[] = [];
  const withInvalidatedAppResolutionCache = async <Result>(
    cacheDevice: DeviceInfo,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    cacheCalls.push(cacheDevice);
    order.push('cache-before');
    try {
      return await operation();
    } finally {
      order.push('cache-after');
    }
  };
  const host = hostFixture({
    withInvalidatedAppResolutionCache,
    resolveAppPackage: async () => {
      order.push('resolve');
      return 'com.example.replaced';
    },
    prepareArtifact: async () => {
      order.push('prepare');
      throw new Error('replacement artifact is invalid');
    },
  });
  native.uninstallAndroidPackage.mockImplementationOnce(async () => {
    order.push('uninstall');
  });

  await expect(
    createAndroidAppDeploymentOperations({
      host,
      device,
      signal: new AbortController().signal,
    }).deployApp?.({
      app: 'Maps',
      appPath: '/tmp/replacement.apk',
      replaceExisting: true,
    }),
  ).rejects.toThrow('replacement artifact is invalid');

  expect(order).toEqual(['cache-before', 'resolve', 'uninstall', 'prepare', 'cache-after']);
  expect(cacheCalls).toEqual([device]);
  expect(native.installAndroidArtifact).not.toHaveBeenCalled();
});

test('keeps ordinary Android install successful when identity is unavailable', async () => {
  native.installAndroidArtifact.mockResolvedValueOnce(undefined);
  const operations = createAndroidAppDeploymentOperations({
    host: hostFixture({
      prepareArtifact: async () => ({ installablePath: '/tmp/app.apk', cleanup: async () => {} }),
    }),
    device,
    signal: new AbortController().signal,
  });

  await expect(
    operations.deployApp?.({ app: '', appPath: '/tmp/app.apk', replaceExisting: false }),
  ).resolves.toEqual({});
  expect(native.inferAndroidAppName).not.toHaveBeenCalled();
});
