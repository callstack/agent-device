import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { LimrunRuntime } from '../providers/limrun/runtime.ts';
import { createExpiredProviderLeaseReleaser } from '../daemon/provider-lease-expiry.ts';
import type { SimulatorLease } from '../daemon/lease-registry.ts';
import type { DeviceInfo } from '../kernel/device.ts';
import { runCmd } from '../utils/exec.ts';

type LimrunInstancePage = {
  getPaginatedItems: () => Array<{ metadata: { id: string } }>;
};

const limrunMockState = vi.hoisted(() => {
  const androidTunnelClose = vi.fn();
  return {
    constructorOptions: [] as Array<{ defaultHeaders?: Record<string, string> }>,
    assetsGetOrUpload: vi.fn(async () => ({
      signedDownloadUrl: 'https://assets.example/app',
      md5: 'asset-md5',
    })),
    iosInstallApp: vi.fn(async () => ({
      bundleId: 'com.example.ios',
      url: 'https://assets.example/app',
    })),
    iosLaunchApp: vi.fn(async () => undefined),
    iosOpenUrl: vi.fn(async () => undefined),
    iosSetOrientation: vi.fn(async () => undefined),
    androidOpenUrl: vi.fn(async () => undefined),
    androidDisconnect: vi.fn(),
    androidSendAsset: vi.fn(async () => undefined),
    androidTunnelClose,
    androidStartAdbTunnel: vi.fn(async () => ({
      address: { address: '127.0.0.1', port: 62_001 },
      close: androidTunnelClose,
    })),
    iosCreate: vi.fn(async () => ({
      metadata: { id: 'ios-instance-1' },
      status: { token: 'instance-token', apiUrl: 'https://ios.example' },
    })),
    iosList: vi.fn<() => Promise<LimrunInstancePage>>(async () => ({
      getPaginatedItems: () => [],
    })),
    iosDelete: vi.fn(async () => undefined),
    androidCreate: vi.fn(async () => ({
      metadata: { id: 'android-instance-1' },
      status: {
        token: 'instance-token',
        apiUrl: 'https://android.example',
        adbWebSocketUrl: 'wss://adb.example',
      },
    })),
    androidList: vi.fn<() => Promise<LimrunInstancePage>>(async () => ({
      getPaginatedItems: () => [],
    })),
    androidDelete: vi.fn(async () => undefined),
  };
});

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: limrunMockState.iosCreate,
      list: limrunMockState.iosList,
      delete: limrunMockState.iosDelete,
    };

    readonly androidInstances = {
      create: limrunMockState.androidCreate,
      list: limrunMockState.androidList,
      delete: limrunMockState.androidDelete,
    };

    readonly assets = {
      getOrUpload: limrunMockState.assetsGetOrUpload,
    };

    constructor(options: { defaultHeaders?: Record<string, string> }) {
      limrunMockState.constructorOptions.push(options);
    }
  },
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: vi.fn(),
    installApp: limrunMockState.iosInstallApp,
    launchApp: limrunMockState.iosLaunchApp,
    openUrl: limrunMockState.iosOpenUrl,
    setOrientation: limrunMockState.iosSetOrientation,
  })),
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: limrunMockState.androidDisconnect,
    openUrl: limrunMockState.androidOpenUrl,
    sendAsset: limrunMockState.androidSendAsset,
    startAdbTunnel: limrunMockState.androidStartAdbTunnel,
  })),
}));

vi.mock('../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  };
});

afterEach(() => {
  limrunMockState.constructorOptions.length = 0;
  vi.clearAllMocks();
});

test('Limrun runtime identifies direct CLI usage to the Limrun API', async () => {
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });

  const lease: SimulatorLease = {
    leaseId: 'lease-a',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };

  try {
    const allocateLease = runtime.leaseLifecycle.allocate;
    if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
    await allocateLease(lease);

    assert.deepEqual(limrunMockState.constructorOptions[0]?.defaultHeaders, {
      'x-agent-device-client': 'agent-device-cli',
      'x-agent-device-version': '9.9.9-test',
    });
    const iosCreateCalls = limrunMockState.iosCreate.mock.calls as unknown as Array<
      [{ metadata?: { labels?: Record<string, string> } }]
    >;
    assert.deepEqual(iosCreateCalls[0]?.[0].metadata?.labels, {
      tenantId: 'team-a',
      runId: 'run-a',
      leaseId: 'lease-a',
      provider: 'limrun',
      source: 'agent-device-cli',
    });
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun iOS uses shared deep-link classification', async () => {
  const runtime = new LimrunRuntime({ apiKey: 'lim_test_key', version: '9.9.9-test' });

  try {
    const device = await allocateLimrunDevice(runtime, {
      ...androidLease(),
      leaseId: 'lease-ios-deep-link',
      backend: 'ios-instance',
    });
    const interactor = runtime.getInteractor(device);
    if (!interactor) throw new Error('Limrun runtime must return an interactor');

    await interactor.open('http:malformed');
    await interactor.open('example://screen');

    assert.deepEqual(limrunMockState.iosLaunchApp.mock.calls, [['http:malformed']]);
    assert.deepEqual(limrunMockState.iosOpenUrl.mock.calls, [['example://screen']]);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun reclaims a labeled iOS instance without an in-memory session', async () => {
  const runtime = new LimrunRuntime({ apiKey: 'lim_test_key', version: '9.9.9-test' });
  const lease: SimulatorLease = {
    leaseId: 'lease-recovered-ios',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
  limrunMockState.iosList.mockResolvedValueOnce({
    getPaginatedItems: () => [{ metadata: { id: 'ios-instance-recovered' } }],
  });

  try {
    const releaseLease = runtime.leaseLifecycle.release;
    if (!releaseLease) throw new Error('Limrun runtime must provide lease release');
    await releaseLease(lease);

    assert.deepEqual(limrunMockState.iosList.mock.calls, [
      [{ labelSelector: 'provider=limrun,leaseId=lease-recovered-ios' }],
    ]);
    assert.deepEqual(limrunMockState.iosDelete.mock.calls, [['ios-instance-recovered']]);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun recovers a failed expired lease release after a daemon restart', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-limrun-expiry-'));
  const lease: SimulatorLease = {
    leaseId: 'lease-recovered-after-restart',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
  const firstRuntime = new LimrunRuntime({ apiKey: 'lim_test_key', version: '9.9.9-test' });
  const firstReleaser = createExpiredProviderLeaseReleaser({
    recoverExpiredLease: firstRuntime.recoverExpiredLease,
    recoverableProviderIds: ['limrun'],
    stateDir,
  });
  let recoveredRuntime: LimrunRuntime | undefined;
  let recoveredReleaser: ReturnType<typeof createExpiredProviderLeaseReleaser> | undefined;

  try {
    const allocateLease = firstRuntime.leaseLifecycle.allocate;
    if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
    await allocateLease(lease);
    limrunMockState.iosDelete.mockRejectedValueOnce(new Error('temporary provider outage'));

    await firstReleaser.release(lease);
    assert.deepEqual(limrunMockState.iosDelete.mock.calls[0], ['ios-instance-1']);
    firstReleaser.shutdown();

    recoveredRuntime = new LimrunRuntime({ apiKey: 'lim_test_key', version: '9.9.9-test' });
    recoveredReleaser = createExpiredProviderLeaseReleaser({
      recoverExpiredLease: recoveredRuntime.recoverExpiredLease,
      recoverableProviderIds: ['limrun'],
      stateDir,
    });
    limrunMockState.iosList.mockResolvedValueOnce({
      getPaginatedItems: () => [{ metadata: { id: 'ios-instance-recovered' } }],
    });
    await recoveredReleaser.retryPending();

    assert.deepEqual(limrunMockState.iosList.mock.calls[0], [
      { labelSelector: 'provider=limrun,leaseId=lease-recovered-after-restart' },
    ]);
    assert.deepEqual(limrunMockState.iosDelete.mock.calls.at(-1), ['ios-instance-recovered']);
  } finally {
    // A crashed daemon cannot run the original runtime's graceful shutdown.
    firstReleaser.shutdown();
    recoveredReleaser?.shutdown();
    await recoveredRuntime?.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Limrun Android reverses localhost URL ports through the persistent ADB tunnel', async () => {
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });

  try {
    vi.mocked(runCmd).mockImplementation(async (_command, args) => ({
      stdout:
        args[2] === 'reverse' && args[3] === '--list' ? '127.0.0.1:62001 tcp:8081 tcp:8081\n' : '',
      stderr: '',
      exitCode: 0,
    }));
    const device = await allocateLimrunDevice(runtime, androidLease());
    const interactor = runtime.getInteractor(device);
    if (!interactor) throw new Error('Limrun runtime must return an interactor');

    await interactor.open('exp://127.0.0.1:8081');
    await runtime.shutdown();

    assertAndroidTunnelLifecycle('exp://127.0.0.1:8081');
  } finally {
    await runtime.shutdown();
  }
});

function androidLease(): SimulatorLease {
  return {
    leaseId: 'lease-android',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

async function allocateLimrunDevice(
  runtime: LimrunRuntime,
  lease: SimulatorLease,
): Promise<DeviceInfo> {
  const allocateLease = runtime.leaseLifecycle.allocate;
  if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
  const allocated = await allocateLease(lease);
  const device = allocated?.device;
  if (!device || typeof device !== 'object') {
    throw new Error('Limrun runtime must return allocated device metadata');
  }
  return device as DeviceInfo;
}

function assertAndroidTunnelLifecycle(openUrl: string): void {
  assert.equal(limrunMockState.androidStartAdbTunnel.mock.calls.length, 1);
  assert.equal(limrunMockState.androidOpenUrl.mock.calls.length, 0);
  assert.deepEqual(vi.mocked(runCmd).mock.calls[0]?.[1], [
    '-s',
    '127.0.0.1:62001',
    'reverse',
    'tcp:8081',
    'tcp:8081',
  ]);
  assert.deepEqual(vi.mocked(runCmd).mock.calls[1]?.[1], [
    '-s',
    '127.0.0.1:62001',
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    openUrl,
  ]);
  assert.deepEqual(vi.mocked(runCmd).mock.calls[2]?.[1], [
    '-s',
    '127.0.0.1:62001',
    'reverse',
    '--list',
  ]);
  assert.deepEqual(vi.mocked(runCmd).mock.calls[3]?.[1], [
    '-s',
    '127.0.0.1:62001',
    'reverse',
    '--remove',
    'tcp:8081',
  ]);
  assert.deepEqual(vi.mocked(runCmd).mock.calls[4]?.[1], ['disconnect', '127.0.0.1:62001']);
  assert.equal(limrunMockState.androidTunnelClose.mock.calls.length, 1);
}

test('Limrun Android installs direct local artifacts through Limrun assets', async () => {
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });
  const lease: SimulatorLease = {
    leaseId: 'lease-android',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };

  try {
    const allocateLease = runtime.leaseLifecycle.allocate;
    if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
    const allocated = await allocateLease(lease);
    const device = allocated?.device;
    if (!device || typeof device !== 'object') {
      throw new Error('Limrun runtime must return allocated device metadata');
    }
    const allocatedDevice = device as Parameters<LimrunRuntime['installApp']>[0];
    assert.equal(allocatedDevice.platform, 'android');
    assert.equal(allocatedDevice.id, 'limrun:android:lease-android');

    const result = await runtime.installApp(
      allocatedDevice,
      'com.example.android',
      '/tmp/app-debug.apk',
    );

    const assetCalls = limrunMockState.assetsGetOrUpload.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    assert.deepEqual(assetCalls[0]?.[0], {
      path: '/tmp/app-debug.apk',
      name: 'com.example.android.apk',
    });
    assert.deepEqual(limrunMockState.androidSendAsset.mock.calls[0], [
      'https://assets.example/app',
    ]);
    assert.deepEqual(result, {
      packageName: 'com.example.android',
      launchTarget: 'com.example.android',
      appName: 'Example',
    });
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun Android shares an in-flight ADB tunnel across concurrent port reverse requests', async () => {
  const runtime = new LimrunRuntime({ apiKey: 'lim_test_key', version: '9.9.9-test' });

  try {
    await allocateLimrunDevice(runtime, androidLease());
    await Promise.all([
      runtime.configurePortReverse({
        leaseId: 'lease-android',
        devicePort: 8081,
        hostPort: 8081,
        name: 'metro',
      }),
      runtime.configurePortReverse({
        leaseId: 'lease-android',
        devicePort: 8097,
        hostPort: 8097,
        name: 'react-devtools',
      }),
    ]);

    assert.equal(limrunMockState.androidStartAdbTunnel.mock.calls.length, 1);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun iOS installs direct local artifacts through Limrun assets', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-limrun-install-'));
  const ipaPath = path.join(tempRoot, 'Demo.ipa');
  fs.writeFileSync(ipaPath, 'demo');
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });
  const lease: SimulatorLease = {
    leaseId: 'lease-ios',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };

  try {
    const allocateLease = runtime.leaseLifecycle.allocate;
    if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
    const allocated = await allocateLease(lease);
    const device = allocated?.device;
    if (!device || typeof device !== 'object') {
      throw new Error('Limrun runtime must return allocated device metadata');
    }

    const result = await runtime.installApp(
      device as Parameters<LimrunRuntime['installApp']>[0],
      'com.example.ios',
      ipaPath,
      { relaunch: true },
    );

    const assetCalls = limrunMockState.assetsGetOrUpload.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    assert.deepEqual(assetCalls[0]?.[0], {
      path: ipaPath,
      name: 'Demo.ipa',
    });
    assert.deepEqual(limrunMockState.iosInstallApp.mock.calls[0], [
      'https://assets.example/app',
      { md5: 'asset-md5', launchMode: 'RelaunchIfRunning' },
    ]);
    assert.deepEqual(result, {
      bundleId: 'com.example.ios',
      launchTarget: 'com.example.ios',
      appName: 'Demo',
    });
  } finally {
    await runtime.shutdown();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Limrun iOS reads the bundle display name before uploading an app bundle', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-limrun-app-name-'));
  const appPath = path.join(tempRoot, 'Renamed.app');
  fs.mkdirSync(appPath);
  fs.writeFileSync(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleDisplayName</key><string>Actual App Name</string>',
      '</dict></plist>',
    ].join(''),
  );
  const runtime = new LimrunRuntime({ apiKey: 'lim_test_key', version: '9.9.9-test' });

  try {
    const device = await allocateLimrunDevice(runtime, {
      ...androidLease(),
      leaseId: 'lease-ios-app-name',
      backend: 'ios-instance',
    });
    const result = await runtime.installApp(
      device as Parameters<LimrunRuntime['installApp']>[0],
      'com.example.ios',
      appPath,
    );

    assert.equal(result?.appName, 'Actual App Name');
  } finally {
    await runtime.shutdown();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Limrun iOS maps supported orientation and rejects unsupported upside-down orientation', async () => {
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });

  try {
    const device = await allocateLimrunDevice(runtime, {
      ...androidLease(),
      leaseId: 'lease-ios-orientation',
      backend: 'ios-instance',
    });
    const interactor = runtime.getInteractor(device);
    if (!interactor) throw new Error('Limrun runtime must return an interactor');

    await interactor.setOrientation('landscape-left');
    await assert.rejects(
      () => interactor.setOrientation('portrait-upside-down'),
      /not portrait upside-down/,
    );

    assert.deepEqual(limrunMockState.iosSetOrientation.mock.calls, [['Landscape']]);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun Android configures an explicit port reverse', async () => {
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });
  const lease: SimulatorLease = {
    leaseId: 'lease-android',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };

  try {
    const allocateLease = runtime.leaseLifecycle.allocate;
    if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
    await allocateLease(lease);

    assert.deepEqual(
      await runtime.configurePortReverse({
        leaseId: lease.leaseId,
        devicePort: 8097,
        hostPort: 8097,
        name: 'react-devtools',
      }),
      {
        leaseId: lease.leaseId,
        devicePort: 8097,
        hostPort: 8097,
        name: 'react-devtools',
      },
    );
    assert.deepEqual(vi.mocked(runCmd).mock.calls[0]?.[1], [
      '-s',
      '127.0.0.1:62001',
      'reverse',
      'tcp:8097',
      'tcp:8097',
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun Android preserves canonical ADB failure classification', async () => {
  const runtime = new LimrunRuntime({ apiKey: 'lim_test_key', version: '9.9.9-test' });

  try {
    await allocateLimrunDevice(runtime, androidLease());
    vi.mocked(runCmd).mockResolvedValueOnce({
      stdout: '',
      stderr: 'error: device offline',
      exitCode: 1,
    });

    await assert.rejects(
      () =>
        runtime.configurePortReverse({
          leaseId: 'lease-android',
          devicePort: 8097,
          hostPort: 8097,
          name: 'react-devtools',
        }),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { details?: { adbFailure?: unknown; retriable?: unknown } }).details
          ?.adbFailure === 'device_offline' &&
        (error as { details?: { retriable?: unknown } }).details?.retriable === true,
    );
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun deletes iOS instance when post-create validation fails', async () => {
  limrunMockState.iosCreate.mockResolvedValueOnce({
    metadata: { id: 'ios-instance-missing-api' },
    status: { token: 'instance-token' },
  } as never);
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });
  const lease: SimulatorLease = {
    leaseId: 'lease-ios',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };

  try {
    const allocateLease = runtime.leaseLifecycle.allocate;
    if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
    await assert.rejects(() => allocateLease(lease), /did not expose apiUrl/);
    assert.deepEqual(limrunMockState.iosDelete.mock.calls[0], ['ios-instance-missing-api']);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun deletes Android instance when post-create validation fails', async () => {
  limrunMockState.androidCreate.mockResolvedValueOnce({
    metadata: { id: 'android-instance-missing-adb' },
    status: {
      token: 'instance-token',
      apiUrl: 'https://android.example',
    },
  } as never);
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });
  const lease: SimulatorLease = {
    leaseId: 'lease-android',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };

  try {
    const allocateLease = runtime.leaseLifecycle.allocate;
    if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
    await assert.rejects(() => allocateLease(lease), /did not expose API and ADB/);
    assert.deepEqual(limrunMockState.androidDelete.mock.calls[0], ['android-instance-missing-adb']);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun keeps session tracked when release fails so release can be retried', async () => {
  const runtime = new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });
  const lease: SimulatorLease = {
    leaseId: 'lease-android',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };

  try {
    const allocateLease = runtime.leaseLifecycle.allocate;
    const releaseLease = runtime.leaseLifecycle.release;
    if (!allocateLease || !releaseLease) {
      throw new Error('Limrun runtime must provide lease lifecycle hooks');
    }
    await allocateLease(lease);
    limrunMockState.androidDelete.mockRejectedValueOnce(new Error('temporary delete failure'));

    await assert.rejects(() => releaseLease(lease), /temporary delete failure/);
    assert.deepEqual(await releaseLease(lease), { limrunInstanceId: 'android-instance-1' });
  } finally {
    await runtime.shutdown();
  }
});
