import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { AppsFilter, DeviceLease } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunRuntime } from './runtime.ts';
import type {
  LimrunAdbProvider,
  LimrunAdbExecutor,
  LimrunPortReverseMapping,
  LimrunRuntimeDependencies,
} from './runtime-dependencies.ts';

const state = vi.hoisted(() => ({
  constructorOptions: [] as Array<{ defaultHeaders?: Record<string, string> }>,
  tunnelClose: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    };

    readonly androidInstances = {
      create: vi.fn(async () => ({
        metadata: { id: 'android-instance-1' },
        status: {
          token: 'instance-token',
          apiUrl: 'https://android.example',
          adbWebSocketUrl: 'wss://adb.example',
        },
      })),
      list: vi.fn(),
      delete: vi.fn(async () => undefined),
    };

    readonly assets = {
      getOrUpload: vi.fn(),
    };

    constructor(options: { defaultHeaders?: Record<string, string> }) {
      state.constructorOptions.push(options);
    }
  },
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: state.disconnect,
    setText: vi.fn(async () => undefined),
    startAdbTunnel: vi.fn(async () => ({
      address: { address: '127.0.0.1', port: 62_001 },
      close: state.tunnelClose,
    })),
  })),
}));

test('factory uses the injected Android and host adapters as its construction seam', async () => {
  const fixture = createContractFixture();
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, fixture.dependencies);

  try {
    const device = await allocateAndroidDevice(runtime);

    assert.equal(runtime.getInteractor(device), fixture.interactor);
    const deviceSession = runtime.getDeviceSession(device);
    assert.equal(deviceSession?.platform, 'android');
    if (deviceSession?.platform !== 'android') throw new Error('Expected Android device session');

    assert.deepEqual(await deviceSession.listApps('all'), [
      { id: 'com.example.app', name: 'Example' },
    ]);
    assert.equal((await deviceSession.getKeyboardState()).visible, false);
    await runtime.configurePortReverse?.({
      leaseId: 'lease-android',
      devicePort: 8081,
      hostPort: 8081,
      name: 'metro',
    });

    assert.deepEqual(state.constructorOptions[0]?.defaultHeaders, {
      'x-agent-device-client': 'agent-device-cli',
      'x-agent-device-version': 'test-version',
    });
    assert.equal(fixture.createInteractor.mock.calls[0]?.[0], device);
    assert.equal(fixture.listApps.mock.calls[0]?.[1], 'all');
    assert.equal(fixture.getKeyboardState.mock.calls.length, 1);
    assert.deepEqual(fixture.adbCalls[0], [
      '-s',
      '127.0.0.1:62001',
      'reverse',
      'tcp:8081',
      'tcp:8081',
    ]);
  } finally {
    await runtime.shutdown();
  }

  assert.deepEqual(fixture.adbCalls.slice(-2), [
    ['-s', '127.0.0.1:62001', 'reverse', '--remove', 'tcp:8081'],
    ['disconnect', '127.0.0.1:62001'],
  ]);
  assert.equal(state.tunnelClose.mock.calls.length, 1);
});

function createContractFixture() {
  const adbCalls: string[][] = [];
  const activeReverseMappings: LimrunPortReverseMapping[] = [];
  const interactor = { open: vi.fn() } as unknown as Interactor;
  const createInteractor = vi.fn((_device: DeviceInfo, _adb: LimrunAdbProvider) => interactor);
  const listApps = vi.fn(async (_adb: LimrunAdbExecutor, _filter: AppsFilter) => [
    { id: 'com.example.app', name: 'Example' },
  ]);
  const getKeyboardState = vi.fn(async () => ({
    visible: false,
    inputOwner: 'unknown' as const,
  }));
  const dependencies = {
    clientVersion: 'test-version',
    android: {
      createInteractor,
      createPortReverse: async (adb: LimrunAdbExecutor) =>
        createInMemoryPortReverse(adb, activeReverseMappings),
      inferAppName: async () => 'Example',
      listApps,
      getForegroundApp: async () => ({
        appId: 'com.example.app',
        activity: '.MainActivity',
      }),
      getKeyboardState,
      dismissKeyboard: async () => ({
        visible: false,
        inputOwner: 'unknown' as const,
        attempts: 0,
        wasVisible: false,
        dismissed: false,
      }),
      readLogs: async () => 'log line\n',
      adbError: async (message: string) => new AppError('COMMAND_FAILED', message),
    },
    host: {
      runAdb: async (args: string[]) => {
        adbCalls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      archiveDirectory: async () => undefined,
    },
    ios: {
      resolveAppAlias: async (app: string) => app,
      readBundleAppName: async () => undefined,
    },
  } satisfies LimrunRuntimeDependencies;
  return { adbCalls, createInteractor, dependencies, getKeyboardState, interactor, listApps };
}

function createInMemoryPortReverse(adb: LimrunAdbExecutor, mappings: LimrunPortReverseMapping[]) {
  return {
    ensure: async (mapping: LimrunPortReverseMapping) => {
      mappings.push(mapping);
      await adb(['reverse', mapping.local, mapping.remote]);
    },
    remove: async (local: LimrunPortReverseMapping['local']) => {
      const index = mappings.findIndex((mapping) => mapping.local === local);
      if (index >= 0) mappings.splice(index, 1);
      await adb(['reverse', '--remove', local]);
    },
    removeAllOwned: async (ownerId: string) => {
      const owned = mappings.filter((mapping) => mapping.ownerId === ownerId);
      for (const mapping of owned) {
        mappings.splice(mappings.indexOf(mapping), 1);
        await adb(['reverse', '--remove', mapping.local]);
      }
    },
    list: async () => [...mappings],
  };
}

async function allocateAndroidDevice(
  runtime: ReturnType<typeof createLimrunRuntime>,
): Promise<DeviceInfo> {
  const allocation = await runtime.leaseLifecycle.allocate?.(androidLease());
  const allocatedDevice = allocation?.device;
  if (!allocatedDevice || typeof allocatedDevice !== 'object') {
    throw new Error('Expected allocated device');
  }
  return allocatedDevice as DeviceInfo;
}

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
