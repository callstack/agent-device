import { afterEach, expect, test, vi } from 'vitest';
import {
  bindLimrunDeployment,
  LIMRUN_IOS_APPS,
} from './limrun-deployment-cancellation.fixtures.ts';

const state = vi.hoisted(() => ({
  assetsGetOrUpload: vi.fn(async (_input: unknown, _options: { signal?: AbortSignal }) => ({
    signedDownloadUrl: 'https://assets.example.test/app',
    md5: 'asset-md5',
  })),
  androidCreate: vi.fn(async () => ({
    metadata: { id: 'limrun-android-instance' },
    status: {
      token: 'instance-token',
      apiUrl: 'https://limrun.example.test',
      adbWebSocketUrl: 'wss://limrun.example.test/adb',
    },
  })),
  androidDelete: vi.fn(async () => undefined),
  androidDisconnect: vi.fn(async () => undefined),
  androidSyncApp: vi.fn(async () => ({ installedBundleId: 'com.example.android' })),
  iosCreate: vi.fn(async () => ({
    metadata: { id: 'limrun-ios-instance' },
    status: { token: 'instance-token', apiUrl: 'https://limrun.example.test' },
  })),
  iosDelete: vi.fn(async () => undefined),
  iosDisconnect: vi.fn(async () => undefined),
  iosSyncApp: vi.fn(async () => ({ installedBundleId: 'com.example.ios' })),
  iosListApps: vi.fn(async () => [
    { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
    { bundleId: 'com.example.ios', name: 'Example', installType: 'User' },
  ]),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly androidInstances = {
      create: state.androidCreate,
      list: vi.fn(async () => ({ getPaginatedItems: () => [] })),
      delete: state.androidDelete,
    };
    readonly iosInstances = {
      create: state.iosCreate,
      list: vi.fn(async () => ({ getPaginatedItems: () => [] })),
      delete: state.iosDelete,
    };
    readonly assets = { getOrUpload: state.assetsGetOrUpload };
  },
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: state.androidDisconnect,
    syncApp: state.androidSyncApp,
    setText: vi.fn(async () => undefined),
    startAdbTunnel: vi.fn(async () => ({
      address: { address: '127.0.0.1', port: 62_001 },
      close: vi.fn(),
    })),
  })),
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: state.iosDisconnect,
    syncApp: state.iosSyncApp,
    listApps: state.iosListApps,
    deviceInfo: { udid: 'ios-device', screenWidth: 402, screenHeight: 874, model: 'iPhone' },
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

for (const platform of ['android', 'ios'] as const) {
  const sync = platform === 'ios' ? state.iosSyncApp : state.androidSyncApp;
  test(`Limrun ${platform} source install keeps caller-owned files until sync settles after cancellation`, async () => {
    const controller = new AbortController();
    const abortReason = new Error('cancel source install');
    const started = deferred<void>();
    const pendingSync = deferred<{ installedBundleId: string }>();
    sync.mockImplementationOnce(() => {
      started.resolve();
      return pendingSync.promise;
    });
    const deployment = await bindLimrunDeployment(platform, controller.signal);
    const artifact = await deployment.materialize();
    const install = deployment.binding.operations.deployMaterializedApp;
    if (!install) throw new Error('Expected materialized deployment operation');
    try {
      const pending = install({ artifact }).finally(() => artifact.cleanup());
      await started.promise;
      controller.abort(abortReason);
      await waitForAsyncTurn();
      expect(deployment.artifactExists()).toBe(true);
      pendingSync.resolve({ installedBundleId: `com.example.${platform}` });
      await expect(pending).rejects.toBe(abortReason);
      expect(deployment.artifactExists()).toBe(false);
    } finally {
      pendingSync.resolve({ installedBundleId: `com.example.${platform}` });
      await deployment.dispose();
    }
  });

  for (const replaceExisting of [false, true]) {
    test(`Limrun ${platform} ${replaceExisting ? 'reinstall' : 'install'} syncs with instance credentials and leaves launch to open`, async () => {
      const deployment = await bindLimrunDeployment(platform, new AbortController().signal);
      sync.mockImplementationOnce(async () => {
        expect(deployment.artifactExists()).toBe(true);
        deployment.events.push('sync');
        return { installedBundleId: `com.example.${platform}` };
      });
      try {
        const result = await deployment.deploy(replaceExisting);
        expect(result.launchTarget).toBe(`com.example.${platform}`);
        expect(sync).toHaveBeenCalledWith(expect.any(String), {
          install: true,
          watch: false,
          launchMode: 'None',
        });
        expect(deployment.events).toEqual([
          ...(replaceExisting ? ['uninstall'] : []),
          'prepare',
          'sync',
          'cleanup',
        ]);
        expect(deployment.artifactExists()).toBe(false);
        expect(state.assetsGetOrUpload).not.toHaveBeenCalled();
        expect(state.iosCreate).not.toHaveBeenCalled();
        expect(state.androidCreate).not.toHaveBeenCalled();
      } finally {
        await deployment.dispose();
      }
    });
  }

  for (const fail of [false, true]) {
    test(`Limrun ${platform} cancellation retains the materialized app until sync ${fail ? 'fails' : 'finishes'}`, async () => {
      const controller = new AbortController();
      const abortReason = new Error('cancel sync');
      const started = deferred<void>();
      const pendingSync = deferred<{ installedBundleId: string }>();
      sync.mockImplementationOnce(() => {
        started.resolve();
        return pendingSync.promise;
      });
      const deployment = await bindLimrunDeployment(platform, controller.signal);
      let disposed = false;
      try {
        const pending = deployment.deploy();
        await started.promise;
        controller.abort(abortReason);
        await expect(pending).rejects.toBe(abortReason);
        const disposing = deployment.binding[Symbol.asyncDispose]().then(() => {
          disposed = true;
        });
        await waitForAsyncTurn();
        expect(disposed).toBe(false);
        expect(deployment.artifactExists()).toBe(true);
        expect(deployment.events).toEqual(['prepare']);
        if (fail) pendingSync.reject(new Error('late sync failure'));
        else pendingSync.resolve({ installedBundleId: `com.example.${platform}` });
        await disposing;
        expect(deployment.artifactExists()).toBe(false);
        expect(deployment.events).toEqual(['prepare', 'cleanup']);
      } finally {
        pendingSync.resolve({ installedBundleId: `com.example.${platform}` });
        await deployment.dispose();
      }
    });
  }
}

test('bound Limrun iOS deployment cancels an in-flight post-install listApps call', async () => {
  const controller = new AbortController();
  const abortReason = new Error('cancel iOS app inventory');
  const inventoryStarted = deferred<void>();
  const inventory = deferred<typeof LIMRUN_IOS_APPS>();
  const systemApp = LIMRUN_IOS_APPS.at(0);
  if (!systemApp) throw new Error('Expected a system iOS app fixture');
  state.iosListApps.mockResolvedValueOnce([systemApp]).mockImplementationOnce(() => {
    inventoryStarted.resolve();
    return inventory.promise;
  });
  const deployment = await bindLimrunDeployment('ios', controller.signal);

  try {
    const pending = deployment.deploy();
    await inventoryStarted.promise;
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(state.iosSyncApp).toHaveBeenCalledOnce();
    expect(state.iosListApps).toHaveBeenCalledTimes(2);
  } finally {
    inventory.resolve(LIMRUN_IOS_APPS);
    await deployment.dispose();
  }
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForAsyncTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
