import { afterEach, expect, test, vi } from 'vitest';
import {
  bindLimrunDeployment,
  LIMRUN_DEPLOYMENT_ASSET,
  LIMRUN_IOS_APPS,
  type LimrunDeploymentAsset,
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
  androidSendAsset: vi.fn(async (_url: string) => undefined),
  iosCreate: vi.fn(async () => ({
    metadata: { id: 'limrun-ios-instance' },
    status: { token: 'instance-token', apiUrl: 'https://limrun.example.test' },
  })),
  iosDelete: vi.fn(async () => undefined),
  iosDisconnect: vi.fn(async () => undefined),
  iosInstallApp: vi.fn(async () => ({ bundleId: 'com.example.ios' })),
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
    sendAsset: state.androidSendAsset,
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
    installApp: state.iosInstallApp,
    listApps: state.iosListApps,
    deviceInfo: { udid: 'ios-device', screenWidth: 402, screenHeight: 874, model: 'iPhone' },
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

test('bound Limrun Android deployment cancels an in-flight getOrUpload call', async () => {
  const controller = new AbortController();
  const abortReason = new Error('cancel Android upload');
  const uploadStarted = deferred<void>();
  const upload = deferred<LimrunDeploymentAsset>();
  state.assetsGetOrUpload.mockImplementationOnce(() => {
    uploadStarted.resolve();
    return upload.promise;
  });
  const deployment = await bindLimrunDeployment('android', controller.signal);

  try {
    const pending = deployment.deploy();
    await uploadStarted.promise;
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(uploadSignal()).toBe(controller.signal);
    expect(state.androidSendAsset).not.toHaveBeenCalled();
  } finally {
    upload.resolve(LIMRUN_DEPLOYMENT_ASSET);
    await deployment.dispose();
  }
});

test('bound Limrun Android deployment cancels an in-flight sendAsset call', async () => {
  const controller = new AbortController();
  const abortReason = new Error('cancel Android send asset');
  const sendStarted = deferred<void>();
  const send = deferred<undefined>();
  state.androidSendAsset.mockImplementationOnce(() => {
    sendStarted.resolve();
    return send.promise;
  });
  const deployment = await bindLimrunDeployment('android', controller.signal);
  let bindingDisposed = false;

  try {
    const pending = deployment.deploy();
    await sendStarted.promise;
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    const disposing = deployment.binding[Symbol.asyncDispose]().then(() => {
      bindingDisposed = true;
    });
    await waitForAsyncTurn();

    expect(bindingDisposed).toBe(false);
    send.resolve(undefined);
    await disposing;
    expect(uploadSignal()).toBe(controller.signal);
    expect(state.androidSendAsset).toHaveBeenCalledWith(LIMRUN_DEPLOYMENT_ASSET.signedDownloadUrl);
  } finally {
    send.resolve(undefined);
    await deployment.dispose();
  }
});

test('bound Limrun Android deployment handles a late sendAsset rejection after caller abort', async () => {
  const controller = new AbortController();
  const abortReason = new Error('cancel Android send asset');
  const lateProviderFailure = new Error('sendAsset rejected after caller cancellation');
  const sendStarted = deferred<void>();
  const send = deferred<undefined>();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  state.androidSendAsset.mockImplementationOnce(() => {
    sendStarted.resolve();
    return send.promise;
  });
  const deployment = await bindLimrunDeployment('android', controller.signal);
  let bindingDisposed = false;

  try {
    const pending = deployment.deploy();
    await sendStarted.promise;
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    const disposing = deployment.binding[Symbol.asyncDispose]().then(() => {
      bindingDisposed = true;
    });
    await waitForAsyncTurn();

    // The opaque WebSocket request has already been accepted by Limrun. The
    // caller may observe cancellation promptly, but request binding disposal
    // must retain ownership until that mutation settles.
    expect(bindingDisposed).toBe(false);
    send.reject(lateProviderFailure);
    await waitForAsyncTurn();
    expect(unhandledRejections).toEqual([]);
    await disposing;
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    send.resolve(undefined);
    if (bindingDisposed) await deployment.dispose();
    else await deployment.shutdown();
  }
});

test('bound Limrun iOS deployment cancels an in-flight getOrUpload call', async () => {
  const controller = new AbortController();
  const abortReason = new Error('cancel iOS upload');
  const uploadStarted = deferred<void>();
  const upload = deferred<LimrunDeploymentAsset>();
  state.assetsGetOrUpload.mockImplementationOnce(() => {
    uploadStarted.resolve();
    return upload.promise;
  });
  const deployment = await bindLimrunDeployment('ios', controller.signal);

  try {
    const pending = deployment.deploy();
    await uploadStarted.promise;
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(uploadSignal()).toBe(controller.signal);
    expect(state.iosInstallApp).not.toHaveBeenCalled();
  } finally {
    upload.resolve(LIMRUN_DEPLOYMENT_ASSET);
    await deployment.dispose();
  }
});

test('bound Limrun iOS deployment cancels an in-flight installApp call', async () => {
  const controller = new AbortController();
  const abortReason = new Error('cancel iOS install');
  const installStarted = deferred<void>();
  const install = deferred<{ bundleId: string }>();
  state.iosListApps.mockResolvedValueOnce(LIMRUN_IOS_APPS);
  state.iosInstallApp.mockImplementationOnce(() => {
    installStarted.resolve();
    return install.promise;
  });
  const deployment = await bindLimrunDeployment('ios', controller.signal);

  try {
    const pending = deployment.deploy();
    await installStarted.promise;
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(uploadSignal()).toBe(controller.signal);
    expect(state.iosInstallApp).toHaveBeenCalledWith(LIMRUN_DEPLOYMENT_ASSET.signedDownloadUrl, {
      launchMode: undefined,
    });
  } finally {
    install.resolve({ bundleId: 'com.example.ios' });
    await deployment.dispose();
  }
});

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
    expect(uploadSignal()).toBe(controller.signal);
    expect(state.iosInstallApp).toHaveBeenCalledOnce();
    expect(state.iosListApps).toHaveBeenCalledTimes(2);
  } finally {
    inventory.resolve(LIMRUN_IOS_APPS);
    await deployment.dispose();
  }
});

function uploadSignal(): AbortSignal | undefined {
  const options = state.assetsGetOrUpload.mock.calls[0]?.[1] as
    | { signal?: AbortSignal }
    | undefined;
  return options?.signal;
}

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
