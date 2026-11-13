import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ClientOptions } from '@limrun/api';
import { createInstanceClient as createAndroidInstanceClient } from '@limrun/api/instance-client';
import { createInstanceClient as createIosInstanceClient } from '@limrun/api/ios-client';
import { LimrunRuntime, type LimrunRuntimeOptions } from '../sdk/limrun.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { commandHostEnvironment, withCommandHost, runCmd } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';
import { mkdtempForTestSync } from '@agent-device/test-kit';

function createTestRuntime(options: LimrunRuntimeOptions): LimrunRuntime {
  return new LimrunRuntime(options, { env: process.env, cwd: process.cwd() });
}

type LimrunInstancePage = {
  getPaginatedItems: () => Array<{ metadata: { id: string } }>;
};

const limrunMockState = vi.hoisted(() => {
  const androidTunnelClose = vi.fn();
  return {
    constructorOptions: [] as ClientOptions[],
    iosInstallApp: vi.fn(async () => ({
      bundleId: 'com.example.ios',
      url: 'https://assets.example/app',
    })),
    iosSyncApp: vi.fn(async () => ({ installedBundleId: 'com.example.ios' })),
    androidSyncApp: vi.fn(async () => ({ installedBundleId: 'com.example.android' })),
    iosSimctl: vi.fn(),
    iosLaunchApp: vi.fn(async () => undefined),
    iosOpenUrl: vi.fn(async () => undefined),
    iosListApps: vi.fn(async () => [
      { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
      { bundleId: 'com.example.ios', name: 'Example', installType: 'User' },
    ]),
    androidOpenUrl: vi.fn(async () => undefined),
    androidDisconnect: vi.fn(),
    androidKeepAlive: vi.fn(),
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
    iosDelete: vi.fn(async (_instanceId: string, _options?: { maxRetries: number }) => undefined),
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
    androidDelete: vi.fn(
      async (_instanceId: string, _options?: { maxRetries: number }) => undefined,
    ),
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

    constructor(options: ClientOptions) {
      limrunMockState.constructorOptions.push(options);
    }
  },
}));

vi.mock('@limrun/api/ios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@limrun/api/ios-client')>();
  limrunMockState.iosSimctl.mockImplementation((args: string[]) => {
    const execution = new actual.SimctlExecution(() => {});
    vi.spyOn(execution, 'wait').mockResolvedValue({
      code: 0,
      stdout:
        args[0] === 'list'
          ? JSON.stringify({ devices: { ios: [{ udid: 'ios-device', state: 'Booted' }] } })
          : '',
      stderr: '',
    });
    return execution;
  });
  return {
    createInstanceClient: vi.fn(async () => ({
      disconnect: vi.fn(),
      installApp: limrunMockState.iosInstallApp,
      syncApp: limrunMockState.iosSyncApp,
      launchApp: limrunMockState.iosLaunchApp,
      openUrl: limrunMockState.iosOpenUrl,
      listApps: limrunMockState.iosListApps,
      simctl: limrunMockState.iosSimctl,
      deviceInfo: {
        udid: 'ios-device',
        screenWidth: 402,
        screenHeight: 874,
        model: 'iPhone',
      },
    })),
  };
});

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: limrunMockState.androidDisconnect,
    keepAlive: limrunMockState.androidKeepAlive,
    openUrl: limrunMockState.androidOpenUrl,
    sendAsset: limrunMockState.androidSendAsset,
    syncApp: limrunMockState.androidSyncApp,
    startAdbTunnel: limrunMockState.androidStartAdbTunnel,
  })),
}));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  };
});

afterEach(() => {
  limrunMockState.constructorOptions.length = 0;
  vi.clearAllMocks();
  vi.mocked(runCmd).mockReset();
});

test('Limrun runtime identifies direct CLI usage when creating an instance', async () => {
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
  });

  const lease: DeviceLease = {
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
    const allocation = await allocateLease(lease);
    const device = allocation?.device as DeviceInfo | undefined;
    if (!device) throw new Error('Limrun runtime must expose its allocated device');
    const deviceSession = runtime.getDeviceSession(device);
    assert.equal(deviceSession?.platform, 'ios');
    assert.equal(deviceSession ? 'client' in deviceSession : true, false);

    assert.equal(limrunMockState.constructorOptions[0]?.defaultHeaders, undefined);
    assert.equal(
      limrunMockState.constructorOptions[0]?.userAgent,
      `agent-device-cli/${readVersion()}`,
    );
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

test('Limrun refuses a refused field on a repeat allocation of its live lease', async () => {
  const runtime = createTestRuntime({ apiKey: 'lim_test_key' });
  const lease: DeviceLease = {
    leaseId: 'lease-repeat',
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
    await assert.rejects(
      allocateLease(lease, { flags: { providerOsVersion: '18.0' } }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        JSON.stringify(error.details?.flags) === '["--provider-os-version"]',
    );
    assert.equal(limrunMockState.iosCreate.mock.calls.length, 1);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun iOS uses shared deep-link classification', async () => {
  const runtime = createTestRuntime({ apiKey: 'lim_test_key' });
  const metadata = new Map([
    ['com.apple.Preferences', '<plist version="1.0"><dict/></plist>'],
    [
      'com.example.ios',
      '<plist version="1.0"><dict><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>example</string></array></dict></array></dict></plist>',
    ],
  ]);
  const fetchMetadata = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const bundleId = new URL(String(input)).searchParams.get('bundleId');
    const plist = metadata.get(bundleId ?? '');
    return new Response(plist ?? '', { status: plist ? 200 : 404 });
  });

  try {
    const device = await allocateLimrunDevice(runtime, {
      ...androidLease(),
      leaseId: 'lease-ios-deep-link',
      backend: 'ios-instance',
    });
    const interactor = runtime.getInteractor(device);
    if (!interactor) throw new Error('Limrun runtime must return an interactor');

    await assert.rejects(interactor.open('http:malformed'), { code: 'APP_NOT_INSTALLED' });
    await interactor.open('example://screen');

    assert.deepEqual(fetchMetadata.mock.calls.map(([input]) => String(input)).sort(), [
      'https://ios.example/files?name=Info.plist&bundleId=com.apple.Preferences&containerType=app',
      'https://ios.example/files?name=Info.plist&bundleId=com.example.ios&containerType=app',
    ]);
    assert.deepEqual(limrunMockState.iosLaunchApp.mock.calls, []);
    assert.deepEqual(limrunMockState.iosOpenUrl.mock.calls, []);
    assert.deepEqual(limrunMockState.iosSimctl.mock.calls, [
      [['list', 'devices', '-j'], undefined],
      [
        [
          'spawn',
          'booted',
          'defaults',
          'write',
          'com.apple.Accessibility',
          'ApplicationAccessibilityEnabled',
          '-bool',
          'YES',
        ],
        undefined,
      ],
      [['openurl', 'booted', 'example://screen'], undefined],
    ]);
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      fetchMetadata.mockRestore();
    }
  }
});

test('Limrun reclaims a labeled iOS instance without an in-memory session', async () => {
  const runtime = createTestRuntime({ apiKey: 'lim_test_key' });
  const lease: DeviceLease = {
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
    assert.deepEqual(limrunMockState.iosDelete.mock.calls, [
      ['ios-instance-recovered', { maxRetries: 0 }],
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun Android reverses localhost URL ports through the persistent ADB tunnel', async () => {
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
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

test('Limrun keepAlive pings the session client every 30 s until release', async () => {
  vi.useFakeTimers();
  try {
    const runtime = createTestRuntime({ apiKey: 'lim_test_key', keepAlive: true });
    const lease = androidLease();
    await allocateLimrunDevice(runtime, lease);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(limrunMockState.androidKeepAlive.mock.calls.length, 2);

    await runtime.leaseLifecycle.release?.(lease);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(limrunMockState.androidKeepAlive.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test('Limrun keepAlive is off by default', async () => {
  vi.useFakeTimers();
  try {
    const runtime = createTestRuntime({ apiKey: 'lim_test_key' });
    await allocateLimrunDevice(runtime, androidLease());
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(limrunMockState.androidKeepAlive.mock.calls.length, 0);
    await runtime.shutdown();
  } finally {
    vi.useRealTimers();
  }
});

test('Limrun keepAlive keeps pinging after the client throws', async () => {
  vi.useFakeTimers();
  try {
    limrunMockState.androidKeepAlive.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });
    const runtime = createTestRuntime({ apiKey: 'lim_test_key', keepAlive: true });
    await allocateLimrunDevice(runtime, androidLease());
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(limrunMockState.androidKeepAlive.mock.calls.length, 2);
    await runtime.shutdown();
  } finally {
    vi.useRealTimers();
  }
});

function androidLease(): DeviceLease {
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
  lease: DeviceLease,
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

test('Limrun Android syncs direct local artifacts', async () => {
  const apkPath = path.join(mkdtempForTestSync('limrun-install-'), 'app-debug.apk');
  fs.writeFileSync(apkPath, 'apk fixture');
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
  });
  const lease: DeviceLease = {
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

    const result = await runtime.installApp(allocatedDevice, 'com.example.android', apkPath);

    assert.equal(limrunMockState.androidSendAsset.mock.calls.length, 0);
    expect(limrunMockState.androidSyncApp).toHaveBeenCalledWith(apkPath, {
      install: true,
      watch: false,
      launchMode: 'None',
      basisCacheDir: expect.any(String),
    });
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
  const runtime = createTestRuntime({ apiKey: 'lim_test_key' });

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

test('Limrun iOS syncs direct local artifacts', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-limrun-install-');
  const ipaPath = path.join(tempRoot, 'Demo.ipa');
  fs.writeFileSync(ipaPath, 'demo');
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
  });
  const lease: DeviceLease = {
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

    assert.equal(limrunMockState.iosInstallApp.mock.calls.length, 0);
    expect(limrunMockState.iosSyncApp).toHaveBeenCalledWith(ipaPath, {
      install: true,
      watch: false,
      launchMode: 'RelaunchIfRunning',
      basisCacheDir: expect.any(String),
    });
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

test('Limrun iOS reads the bundle display name before syncing an app bundle', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-limrun-app-name-');
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
  const runtime = createTestRuntime({ apiKey: 'lim_test_key' });

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

test('Limrun Android configures an explicit port reverse', async () => {
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
  });
  const lease: DeviceLease = {
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
  const runtime = createTestRuntime({ apiKey: 'lim_test_key' });

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
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
  });
  const lease: DeviceLease = {
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
    assert.equal(limrunMockState.iosDelete.mock.calls[0]?.[0], 'ios-instance-missing-api');
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
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
  });
  const lease: DeviceLease = {
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
    assert.equal(limrunMockState.androidDelete.mock.calls[0]?.[0], 'android-instance-missing-adb');
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun keeps session tracked when release fails so release can be retried', async () => {
  const runtime = createTestRuntime({
    apiKey: 'lim_test_key',
  });
  const lease: DeviceLease = {
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

    // An unconfirmed delete is reported as such, with the instance still held, rather than as a release.
    await assert.rejects(
      () => releaseLease(lease),
      (error: unknown) => {
        const details = (error as AppError).details;
        return (
          error instanceof AppError &&
          details?.reason === 'limrun_instance_delete_unconfirmed' &&
          details.limrunInstanceId === 'android-instance-1' &&
          details.cause === 'temporary delete failure'
        );
      },
    );
    assert.deepEqual(await releaseLease(lease), { limrunInstanceId: 'android-instance-1' });
  } finally {
    await runtime.shutdown();
  }
});

const ATTACHED_IOS = {
  apiUrl: 'https://region.limrun.example/v1/ios_attached/api',
  token: 'ios-instance-token',
};
const ATTACHED_ANDROID = {
  apiUrl: 'https://region.limrun.example/v1/android_attached/api',
  token: 'android-instance-token',
  adbUrl: 'wss://region.limrun.example/v1/android_attached/adb',
};

function iosLease(leaseId: string): DeviceLease {
  return { ...androidLease(), leaseId, backend: 'ios-instance' };
}

test('Limrun drives existing instances without an API key and never deletes them', async () => {
  const runtime = createTestRuntime({
    instances: { ios: ATTACHED_IOS, android: ATTACHED_ANDROID },
  });
  const releaseLease = runtime.leaseLifecycle.release;
  const allocateLease = runtime.leaseLifecycle.allocate;
  if (!allocateLease || !releaseLease) throw new Error('Limrun runtime must provide lease hooks');

  try {
    const ios = await allocateLease(iosLease('lease-attached-ios'), { initialApp: 'Example.ipa' });
    await allocateLease({ ...androidLease(), leaseId: 'lease-attached-android' });

    assert.match(String(ios?.limrunInstanceId), /^attached-[a-f0-9]{12}$/);
    assert.deepEqual(vi.mocked(createIosInstanceClient).mock.calls, [
      [{ ...ATTACHED_IOS, logLevel: 'warn' }],
    ]);
    assert.deepEqual(vi.mocked(createAndroidInstanceClient).mock.calls, [
      [{ ...ATTACHED_ANDROID, logLevel: 'warn' }],
    ]);

    await releaseLease(iosLease('lease-attached-ios'));
    await releaseLease({ ...androidLease(), leaseId: 'lease-attached-android' });
    assert.equal(await releaseLease(iosLease('lease-before-daemon-restart')), undefined);
    assert.equal(limrunMockState.androidDisconnect.mock.calls.length, 1);
  } finally {
    await runtime.shutdown();
  }
  assert.equal(limrunMockState.constructorOptions.length, 0);
  for (const controlPlaneCall of [
    limrunMockState.iosCreate,
    limrunMockState.iosList,
    limrunMockState.iosDelete,
    limrunMockState.androidCreate,
    limrunMockState.androidList,
    limrunMockState.androidDelete,
  ]) {
    assert.equal(controlPlaneCall.mock.calls.length, 0);
  }
});

test('Limrun removes only its own port reverse mappings from an attached Android instance', async () => {
  const runtime = createTestRuntime({ instances: { android: ATTACHED_ANDROID } });
  const lease = { ...androidLease(), leaseId: 'lease-attached-android' };
  vi.mocked(runCmd).mockImplementation(async (_command, args) => ({
    stdout: args.includes('--list')
      ? 'host-7 tcp:8081 tcp:8081\nhost-9 tcp:8097 tcp:8097\nhost-9 tcp:8099 tcp:8099\n'
      : '',
    stderr: '',
    exitCode: 0,
  }));

  const device = await allocateLimrunDevice(runtime, lease);
  await runtime.configurePortReverse({
    leaseId: lease.leaseId,
    devicePort: 8097,
    hostPort: 8097,
    name: 'react-devtools',
  });
  await runtime.getInteractor(device)?.open('http://127.0.0.1:8099/');
  await runtime.shutdown();

  const removals = vi
    .mocked(runCmd)
    .mock.calls.map(([, args]) => args)
    .filter((args) => args.includes('--remove'))
    .map((args) => args.at(-1))
    .sort();
  assert.deepEqual(removals, ['tcp:8097', 'tcp:8099']);
});

test('Limrun refuses to replace an owner port reverse on an attached Android instance', async () => {
  const runtime = createTestRuntime({ instances: { android: ATTACHED_ANDROID } });
  const lease = { ...androidLease(), leaseId: 'lease-attached-android' };
  vi.mocked(runCmd).mockImplementation(async (_command, args) =>
    args.includes('--no-rebind')
      ? { stdout: '', stderr: 'adb: error: cannot rebind existing socket', exitCode: 1 }
      : {
          stdout: args.includes('--list') ? 'owner-host tcp:8081 tcp:8081\n' : '',
          stderr: '',
          exitCode: 0,
        },
  );
  const isRebindRefusal = (error: unknown) =>
    (error as { details?: { reason?: unknown } }).details?.reason ===
    'android_port_reverse_rebind_refused';

  const device = await allocateLimrunDevice(runtime, lease);
  await assert.rejects(
    () =>
      runtime.configurePortReverse({
        leaseId: lease.leaseId,
        devicePort: 8081,
        hostPort: 8081,
        name: 'metro',
      }),
    isRebindRefusal,
  );
  const interactor = runtime.getInteractor(device);
  if (!interactor) throw new Error('Limrun runtime must return an interactor');
  await assert.rejects(() => interactor.open('exp://127.0.0.1:8081'), isRebindRefusal);
  await runtime.shutdown();

  const reverseCalls = vi
    .mocked(runCmd)
    .mock.calls.map(([, args]) => args.slice(2))
    .filter((args) => args[0] === 'reverse' && args[1] !== '--list');
  assert.deepEqual(reverseCalls, [
    ['reverse', '--no-rebind', 'tcp:8081', 'tcp:8081'],
    ['reverse', '--no-rebind', 'tcp:8081', 'tcp:8081'],
  ]);
});

test('Limrun instance access wins over the API key for its platform only', async () => {
  const runtime = createTestRuntime({ apiKey: 'lim_test_key', instances: { ios: ATTACHED_IOS } });

  await allocateLimrunDevice(runtime, iosLease('lease-attached-ios'));
  await allocateLimrunDevice(runtime, androidLease());
  await runtime.shutdown();

  assert.equal(limrunMockState.iosCreate.mock.calls.length, 0);
  assert.equal(limrunMockState.iosDelete.mock.calls.length, 0);
  assert.equal(limrunMockState.androidCreate.mock.calls.length, 1);
  assert.deepEqual(
    limrunMockState.androidDelete.mock.calls.map(([instanceId]) => instanceId),
    ['android-instance-1'],
  );
});

test('Limrun without an API key refuses operations that need one', async () => {
  const runtime = createTestRuntime({ instances: { ios: ATTACHED_IOS } });

  try {
    await assert.rejects(allocateLimrunDevice(runtime, androidLease()), {
      code: 'UNSUPPORTED_OPERATION',
      message: 'Creating an instance requires a Limrun API key.',
    });
  } finally {
    await runtime.shutdown();
  }
  assert.throws(() => createTestRuntime({}), /requires an apiKey or instance access/);
});

test('Limrun attaches an existing instance under a consumed field and refuses a refused one', async () => {
  const runtime = createTestRuntime({ instances: { ios: ATTACHED_IOS } });
  const allocateLease = runtime.leaseLifecycle.allocate;
  if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
  try {
    await assert.rejects(
      allocateLease(iosLease('lease-refused'), { flags: { providerOsVersion: '18.0' } }),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
    assert.equal(vi.mocked(createIosInstanceClient).mock.calls.length, 0);
    const ios = await allocateLease(iosLease('lease-attached-ios'), {
      flags: { providerApp: 'Example.ipa' },
    });
    assert.match(String(ios?.limrunInstanceId), /^attached-[a-f0-9]{12}$/);
  } finally {
    await runtime.shutdown();
  }
});

test('public Limrun runtimes keep their hosts in concurrent deferred Android callbacks', async () => {
  const host = (owner: string) => ({ env: { SDK_OWNER: owner }, cwd: process.cwd() });
  const runtimes = ['first', 'second'].map(
    (owner) => new LimrunRuntime({ apiKey: 'lim_test_key' }, host(owner)),
  );
  vi.mocked(runCmd).mockImplementation(async () => ({
    stdout: `mCurrentFocus=Window{1 u0 com.${commandHostEnvironment().env.SDK_OWNER}/.MainActivity}`,
    stderr: '',
    exitCode: 0,
  }));
  try {
    const sessions = await Promise.all(
      runtimes.map(async (runtime) => {
        const device = await allocateLimrunDevice(runtime, androidLease());
        const session = runtime.getDeviceSession(device);
        assert.ok(session?.platform === 'android');
        return session;
      }),
    );
    const results = await withCommandHost(
      { host: host('foreign'), requestEnv: { SDK_OWNER: 'request' } },
      () => Promise.all(sessions.map((session) => session.getForegroundApp())),
    );
    expect(results.map((app) => app?.appId)).toEqual(['com.first', 'com.second']);
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
  }
});
