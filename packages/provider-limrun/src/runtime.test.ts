import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { AppsFilter, DeviceLease } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
} from '@agent-device/platform-android/mechanics';
import { createLimrunRuntime } from './runtime.ts';
import { unusedLimrunRuntimeHost } from './runtime.fixtures.ts';
import type { LimrunAdbExecutor, LimrunRuntimeDependencies } from './runtime-dependencies.ts';

/**
 * The provider's platform module is the daemon's real load path: `createLimrunRuntime(...,
 * { includePlatformModule: true })`, then `loadRuntime(host)`, then `bind`. These cases drive the
 * app-state reader `loadLimrunPlatformRuntime` wires onto the runtime implementation through that
 * entry, which no owner-level test reaches because those hand-author their owner options.
 */

const state = vi.hoisted(() => ({
  foreground: { appId: 'com.example.app', activity: '.MainActivity' } as
    | { appId?: string; activity?: string }
    | undefined,
  disconnect: vi.fn(),
  tunnelClose: vi.fn(),
  startTunnel: vi.fn(async (): Promise<{ close: () => void }> => ({ close: () => {} })),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };
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
    readonly assets = { getOrUpload: vi.fn(), list: vi.fn() };
  },
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: state.disconnect,
    keepAlive: vi.fn(),
    openUrl: vi.fn(),
    sendAsset: vi.fn(),
    pressKey: vi.fn(),
    setText: vi.fn(),
    tap: vi.fn(),
    startAdbTunnel: vi.fn(async () => ({
      address: { address: '127.0.0.1', port: 62_001 },
      close: state.tunnelClose,
    })),
    startTunnel: state.startTunnel,
  })),
}));

test('the platform module answers app state from the live Android provider session', async () => {
  const registration = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'test-instance' },
    testDependencies(),
    { includePlatformModule: true },
  );
  try {
    const device = await allocateAndroidDevice(registration.runtime);
    const owner = await registration.platformModule.loadRuntime(unusedLimrunRuntimeHost());
    const binding = await owner.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: requestScope(),
    });

    assert.equal(binding.facts.operations.appState.available, true);
    assert.deepEqual(await binding.operations.appState?.(), {
      package: 'com.example.app',
      activity: '.MainActivity',
    });

    // An instance with no foreground application answers with an empty state rather than failing.
    state.foreground = undefined;
    assert.deepEqual(await binding.operations.appState?.(), {
      package: undefined,
      activity: undefined,
    });
  } finally {
    await registration.runtime.shutdown();
  }
});

test('the platform module refuses app state once the provider session died behind the device id', async () => {
  const registration = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'test-instance' },
    testDependencies(),
    { includePlatformModule: true },
  );
  try {
    const device = await allocateAndroidDevice(registration.runtime);
    const owner = await registration.platformModule.loadRuntime(unusedLimrunRuntimeHost());
    const binding = await owner.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: requestScope(),
    });
    // The lease can end between admission and the read; the reader fails closed on the lost
    // session instead of reporting a foreground app it can no longer observe.
    await registration.runtime.shutdown();

    await assert.rejects(
      async () => await binding.operations.appState?.(),
      (error) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
    );
  } finally {
    await registration.runtime.shutdown();
  }
});

test('the runtime inventory answers only for its own live lease', async () => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  try {
    // A request for another provider or without a lease is not the runtime's to answer.
    assert.equal(await runtime.deviceInventoryProvider?.({ leaseProvider: 'maestro' }), null);
    assert.equal(await runtime.deviceInventoryProvider?.({ leaseProvider: 'limrun' }), null);
    // A limrun lease with no live session declines; the daemon keeps its own inventory answer.
    assert.equal(
      await runtime.deviceInventoryProvider?.({ leaseProvider: 'limrun', leaseId: 'lease-none' }),
      null,
    );

    const device = await allocateAndroidDevice(runtime, 'lease-inventory');
    const request = { leaseProvider: 'limrun', leaseId: 'lease-inventory' };
    assert.deepEqual(await runtime.deviceInventoryProvider?.(request), [device]);
    // A platform filter that cannot match the leased platform answers an authoritative empty set.
    assert.deepEqual(
      await runtime.deviceInventoryProvider?.({ ...request, platform: 'apple' }),
      [],
    );
  } finally {
    await runtime.shutdown();
  }
});

test('the platform module surfaces an aborted request inside the app-state reader', async () => {
  const registration = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'test-instance' },
    testDependencies(),
    { includePlatformModule: true },
  );
  const abort = new AbortController();
  try {
    const device = await allocateAndroidDevice(registration.runtime);
    const owner = await registration.platformModule.loadRuntime(unusedLimrunRuntimeHost());
    const binding = await owner.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: requestScope(abort.signal),
    });
    abort.abort(new AppError('COMMAND_CANCELLED', 'fixture request canceled'));

    await assert.rejects(
      async () => await binding.operations.appState?.(),
      (error) => error instanceof AppError && error.code === 'COMMAND_CANCELLED',
    );
  } finally {
    await registration.runtime.shutdown();
  }
});

test('shutdown stops a live network capture and concurrent binds share one capture', async () => {
  let tunnelCloseCount = 0;
  state.startTunnel.mockImplementationOnce(async () => ({
    close: () => {
      tunnelCloseCount += 1;
    },
  }));
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  try {
    const device = await allocateAndroidDevice(runtime, 'lease-capture');
    // Two requests bound at once must share one capture, so one session opens at most one tunnel.
    const [first, second] = await Promise.all([
      runtime.networkCaptureFor(device),
      runtime.networkCaptureFor(device),
    ]);
    assert.ok(first);
    assert.equal(first, second);

    const started = await first.start(undefined);
    assert.equal(started.ok, true);
    assert.equal(state.startTunnel.mock.calls.length, 1);

    // Release owns the tunnel's lifecycle: shutdown must close it, never leave it live on the
    // instance after the session ends.
    await runtime.shutdown();
    assert.equal(tunnelCloseCount, 1);
  } finally {
    await runtime.shutdown();
  }
});

function requestScope(signal: AbortSignal = new AbortController().signal): PlatformRequestScope {
  return {
    signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

async function allocateAndroidDevice(
  runtime: ReturnType<typeof createLimrunRuntime>,
  leaseId = 'lease-appstate',
): Promise<DeviceInfo> {
  const lease: DeviceLease = {
    leaseId,
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
  const allocation = await runtime.leaseLifecycle.allocate?.(lease);
  const device = allocation?.device;
  if (!device || typeof device !== 'object') throw new Error('Expected allocated device');
  return device as DeviceInfo;
}

function testDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: 'test-version',
    android: {
      createInteractor: () => ({}) as Interactor,
      createPortReverse: async () => ({
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
        list: async () => [],
      }),
      inferAppName: async () => 'Example',
      listApps: async (_adb: LimrunAdbExecutor, _filter: AppsFilter) => [],
      getForegroundApp: async () => (state.foreground ? { ...state.foreground } : undefined),
      getKeyboardState: async () => ({ visible: false, inputOwner: 'unknown' as const }),
      dismissKeyboard: async () => ({
        visible: false,
        inputOwner: 'unknown' as const,
        attempts: 0,
        wasVisible: false,
        dismissed: false,
      }),
      readLogs: async () => '',
      forceStopApp: async () => {},
      deviceAdbInvocation: (serial: string, command: readonly string[]) =>
        androidAdbInvocation(androidAdbSerialTarget(serial), command),
      hostAdbInvocation: (command: readonly string[]) =>
        androidAdbInvocation(androidAdbHostTarget(), command),
      adbError: async (message: string) => new AppError('COMMAND_FAILED', message),
    },
    host: {
      runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      archiveDirectory: async () => undefined,
      downloadFile: async () => undefined,
    },
    ios: {
      applySimctlSetting: async () => undefined,
      resolveAppAlias: async (app: string) => app,
      readBundleAppName: async () => undefined,
    },
  } satisfies LimrunRuntimeDependencies;
}
