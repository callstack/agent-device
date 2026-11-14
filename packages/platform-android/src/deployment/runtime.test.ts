import { beforeEach, expect, test, vi } from 'vitest';
import type { AndroidAppDeploymentExecutor } from '@agent-device/contracts/app-deployment-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

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

test('keeps the installed app when reinstall preparation fails and still invalidates the cache', async () => {
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
      throw new AppError('INVALID_ARGS', 'replacement artifact is invalid');
    },
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
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'replacement artifact is invalid',
  });

  expect(order).toEqual(['cache-before', 'resolve', 'prepare', 'cache-after']);
  expect(cacheCalls).toEqual([device]);
  expect(native.uninstallAndroidPackage).not.toHaveBeenCalled();
  expect(native.installAndroidArtifact).not.toHaveBeenCalled();
});

test('does not uninstall when reinstall is cancelled after preparation', async () => {
  const controller = new AbortController();
  const cleanup = vi.fn(async () => {});
  const host = hostFixture({
    prepareArtifact: async () => {
      controller.abort(new Error('cancelled'));
      return { installablePath: '/tmp/new.apk', cleanup };
    },
  });

  await expect(
    createAndroidAppDeploymentOperations({ host, device, signal: controller.signal }).deployApp?.({
      app: 'com.example.app',
      appPath: '/tmp/new.apk',
      replaceExisting: true,
    }),
  ).rejects.toThrow('cancelled');

  expect(native.uninstallAndroidPackage).not.toHaveBeenCalled();
  expect(native.installAndroidArtifact).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
});

test('cleans the prepared artifact when the reinstall uninstall fails', async () => {
  const cleanup = vi.fn(async () => {});
  const host = hostFixture({
    prepareArtifact: async () => ({ installablePath: '/tmp/new.apk', cleanup }),
  });
  native.uninstallAndroidPackage.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'adb uninstall failed'),
  );

  await expect(
    createAndroidAppDeploymentOperations({
      host,
      device,
      signal: new AbortController().signal,
    }).deployApp?.({ app: 'com.example.app', appPath: '/tmp/new.apk', replaceExisting: true }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', message: 'adb uninstall failed' });

  expect(native.installAndroidArtifact).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
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

test.each([
  [
    'an installed package',
    async (): Promise<string> => 'com.example.demo',
    { wasInstalled: true, packageName: 'com.example.demo' },
  ],
  ['a missing package', notInstalled, { wasInstalled: false }],
] as const)('uninstall of %s', async (_name, resolveAppPackage, expected) => {
  const host = hostFixture({ resolveAppPackage });
  const operations = createAndroidAppDeploymentOperations({
    host,
    device,
    signal: new AbortController().signal,
  });

  await expect(operations.uninstallApp?.({ app: 'com.example.demo' })).resolves.toEqual(expected);
  expect(native.uninstallAndroidPackage).toHaveBeenCalledTimes(expected.wasInstalled ? 1 : 0);
});

test('uninstall refuses a name that matches no installed package', async () => {
  const operations = createAndroidAppDeploymentOperations({
    host: hostFixture({ resolveAppPackage: notInstalled }),
    device,
    signal: new AbortController().signal,
  });

  await expect(operations.uninstallApp?.({ app: 'Demo' })).rejects.toMatchObject({
    code: 'APP_NOT_INSTALLED',
  });
  expect(native.uninstallAndroidPackage).not.toHaveBeenCalled();
});

async function notInstalled(): Promise<string> {
  throw new AppError('APP_NOT_INSTALLED', 'No package found');
}

test('uninstall resolves, removes and invalidates on the device readiness returns', async () => {
  const live = { ...device, id: 'emulator-5556', booted: true };
  ensureAndroidReady.mockResolvedValueOnce(live);
  const resolveAppPackage = vi.fn(async (): Promise<string> => 'com.example.demo');
  const cacheDevices: DeviceInfo[] = [];
  const host = hostFixture({
    resolveAppPackage,
    withInvalidatedAppResolutionCache: async (cacheDevice, operation) => {
      cacheDevices.push(cacheDevice);
      return await operation();
    },
  });
  const signal = new AbortController().signal;

  await createAndroidAppDeploymentOperations({
    host,
    device: { ...device, id: 'Pixel_9_API_35', booted: false },
    signal,
  }).uninstallApp?.({ app: 'com.example.demo' });

  expect(cacheDevices).toEqual([live]);
  expect(resolveAppPackage).toHaveBeenCalledWith(live, 'com.example.demo', { installedOnly: true });
  expect(native.uninstallAndroidPackage).toHaveBeenCalledWith(
    host,
    live,
    'com.example.demo',
    signal,
  );
});

test.each([false, true])(
  'reinstall materializes the replacement before removing data with a hosted installer: %s',
  async (hosted) => {
    const events: string[] = [];
    const signal = new AbortController().signal;
    const artifact = {
      installablePath: '/tmp/new.apk',
      cleanup: async () => {
        events.push('cleanup');
      },
    };
    const install = vi.fn(async () => {
      events.push('install');
      return { packageName: 'com.example.app' };
    });
    native.uninstallAndroidPackage.mockImplementation(async () => {
      events.push('uninstall');
    });
    native.installAndroidArtifact.mockImplementation(async () => {
      events.push('install');
      return 'com.example.app';
    });
    const host = hostFixture({
      withInvalidatedAppResolutionCache: async (_device, operation) => {
        events.push('invalidate-before');
        try {
          return await operation();
        } finally {
          events.push('invalidate-after');
        }
      },
      prepareArtifact: async () => {
        events.push('materialize');
        return artifact;
      },
    });
    const operations = createAndroidAppDeploymentOperations({
      host,
      device,
      signal,
      ...(hosted ? { install } : {}),
    });
    expect(
      await operations.deployApp!({
        app: 'com.example.app',
        appPath: '/tmp/new.apk',
        replaceExisting: true,
      }),
    ).toEqual({ packageName: 'com.example.app', launchTarget: 'com.example.app' });
    expect(events).toEqual([
      'invalidate-before',
      'materialize',
      'uninstall',
      'install',
      'cleanup',
      'invalidate-after',
    ]);
    if (hosted) {
      expect(install).toHaveBeenCalledExactlyOnceWith(artifact, signal);
      expect(native.installAndroidArtifact).not.toHaveBeenCalled();
    } else {
      expect(install).not.toHaveBeenCalled();
      expect(native.installAndroidArtifact).toHaveBeenCalledExactlyOnceWith(
        host,
        device,
        artifact.installablePath,
        undefined,
        signal,
      );
    }
  },
);

test.each(['path', 'prepared'] as const)(
  'a hosted %s install uses the provider identity and leaves artifact cleanup with its owner',
  async (source) => {
    const cleanup = vi.fn(async () => {});
    const artifact = { installablePath: '/tmp/app.apk', cleanup };
    const prepareArtifact = vi.fn(async () => artifact);
    const install = vi.fn(async () => ({ packageName: 'com.example.hosted' }));
    const signal = new AbortController().signal;
    const operations = createAndroidAppDeploymentOperations({
      host: hostFixture({ prepareArtifact }),
      device,
      signal,
      install,
    });

    const result =
      source === 'path'
        ? await operations.deployApp!({
            app: '',
            appPath: artifact.installablePath,
            replaceExisting: false,
          })
        : await operations.deployMaterializedApp!({ artifact });

    expect(result).toEqual({
      packageName: 'com.example.hosted',
      appName: 'hosted',
      launchTarget: 'com.example.hosted',
    });
    expect(install).toHaveBeenCalledExactlyOnceWith(artifact, signal);
    expect(native.installAndroidArtifact).not.toHaveBeenCalled();
    expect(prepareArtifact).toHaveBeenCalledTimes(source === 'path' ? 1 : 0);
    expect(cleanup).toHaveBeenCalledTimes(source === 'path' ? 1 : 0);
  },
);

test.each(['path', 'prepared'] as const)(
  'a hosted %s install preserves provider metadata and falls back to materialized identity',
  async (source) => {
    const artifact = {
      installablePath: '/tmp/app.apk',
      packageName: 'com.example.materialized',
      appName: 'Materialized app',
      cleanup: vi.fn(async () => {}),
    };
    const providerResult = {
      appName: 'Provider app',
      launchTarget: 'com.example.materialized/.MainActivity',
    };
    const install = vi.fn(async () => providerResult);
    const operations = createAndroidAppDeploymentOperations({
      host: hostFixture({ prepareArtifact: async () => artifact }),
      device,
      signal: new AbortController().signal,
      install,
    });
    const result =
      source === 'path'
        ? await operations.deployApp!({
            app: '',
            appPath: artifact.installablePath,
            replaceExisting: false,
          })
        : await operations.deployMaterializedApp!({ artifact });
    expect(result).toEqual({ ...providerResult, packageName: artifact.packageName });
  },
);
