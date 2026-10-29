import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
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
  androidDelete: vi.fn(async () => undefined),
  inspectionEvents: [] as ((event: unknown) => void)[],
  destinationTunnelClose: vi.fn(),
  tunnelStatus: {} as Record<string, unknown>,
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
      delete: state.androidDelete,
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
    startTunnel: vi.fn(async (options: { onInspectionEvent: (event: unknown) => void }) => {
      state.inspectionEvents.push(options.onInspectionEvent);
      return { tunnelId: 't1', selectors: [], close: state.destinationTunnelClose };
    }),
    getTunnelStatus: vi.fn(async () => state.tunnelStatus),
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

function requestScope(signal: AbortSignal = new AbortController().signal): PlatformRequestScope {
  return {
    signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

test('a network capture reports its HAR and failures through artifacts and every release attempt', async () => {
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: mkdtempForTestSync('limrun-runtime-har-') },
    testDependencies(),
  );
  const lease = androidLease('lease-capture');
  try {
    await runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } });
    state.inspectionEvents.at(-1)?.(failedRequest('https://api.example.com/login'));

    const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
    const harPath = listed?.cloudArtifacts[0]?.url;
    assert.match(String(harPath), /android-instance-1-lease-capture\.har$/);
    assert.match(String(listed?.message), /request-failed 1, latest api\.example\.com:443/);

    const release = runtime.leaseLifecycle.release;
    assert.ok(release);
    state.androidDelete.mockRejectedValueOnce(new Error('temporary delete failure'));
    await assert.rejects(() => release(lease), /temporary delete failure/);
    const retried = (await release(lease)) as {
      cloudArtifacts?: { cloudArtifacts: { url?: string }[]; message?: string };
    };
    assert.equal(retried.cloudArtifacts?.cloudArtifacts[0]?.url, harPath);
    assert.match(String(retried.cloudArtifacts?.message), /request-failed 1/);
    assert.equal(state.destinationTunnelClose.mock.calls.length, 1);
  } finally {
    await runtime.shutdown?.();
  }
});

test('a repeat allocation starts the capture it newly asks for, and a dial-only failure is reported', async () => {
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: mkdtempForTestSync('limrun-runtime-har-') },
    testDependencies(),
  );
  const lease = androidLease('lease-repeat');
  state.tunnelStatus = {
    lastDialFailure: { tunnelId: 't1', selectorId: 's1', reason: 'connection_refused' },
  };
  try {
    const first = await runtime.leaseLifecycle.allocate?.(lease);
    assert.equal(first?.networkHar, undefined);
    const repeat = await runtime.leaseLifecycle.allocate?.(lease, {
      flags: { providerNetworkLogs: true },
    });
    assert.equal((repeat?.networkHar as { status?: string } | undefined)?.status, 'capturing');

    const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
    assert.match(String(listed?.message), /last dial failure connection_refused/);
  } finally {
    state.tunnelStatus = {};
    await runtime.shutdown?.();
  }
});

test('a repeat allocation retries a capture that could not start', async () => {
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: mkdtempForTestSync('limrun-runtime-har-') },
    testDependencies(),
  );
  const lease = androidLease('lease-retry');
  try {
    const first = await runtime.leaseLifecycle.allocate?.(lease, {
      flags: { providerNetworkLogs: true, providerNetworkHosts: 'not a host!!' },
    });
    assert.equal((first?.networkHar as { status?: string } | undefined)?.status, 'unavailable');
    const retried = await runtime.leaseLifecycle.allocate?.(lease, {
      flags: { providerNetworkLogs: true, providerNetworkHosts: 'api.example.com' },
    });
    assert.equal((retried?.networkHar as { status?: string } | undefined)?.status, 'capturing');
  } finally {
    await runtime.shutdown?.();
  }
});

test('a stopped capture past the retention limit loses its record and its HAR file', async () => {
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: mkdtempForTestSync('limrun-runtime-har-') },
    testDependencies(),
  );
  const release = runtime.leaseLifecycle.release;
  assert.ok(release);
  const harPaths: string[] = [];
  try {
    // 33 stopped captures; the 34th start evicts the oldest.
    for (let index = 0; index < 34; index += 1) {
      const lease = androidLease(`lease-retention-${index}`);
      const allocation = await runtime.leaseLifecycle.allocate?.(lease, {
        flags: { providerNetworkLogs: true },
      });
      harPaths.push(String((allocation?.networkHar as { harPath?: string } | undefined)?.harPath));
      if (index < 33) await release(lease);
    }
    assert.equal(fs.existsSync(harPaths[0] ?? ''), false);
    assert.equal(fs.existsSync(harPaths[1] ?? ''), true);
    assert.equal(
      await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: 'lease-retention-0' }),
      undefined,
    );
  } finally {
    await runtime.shutdown?.();
  }
});

test('a network capture that cannot start is an unavailable artifact with its typed reason', async () => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-no-dir');
  try {
    const allocation = await runtime.leaseLifecycle.allocate?.(lease, {
      flags: { providerNetworkLogs: true },
    });
    assert.deepEqual(allocation?.networkHar, {
      status: 'unavailable',
      reason: 'capture-dir-unset',
      message: 'The runtime has no directory for network capture files.',
    });
    const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
    assert.equal(listed?.status, 'unavailable');
    assert.deepEqual(listed?.cloudArtifacts[0]?.metadata, { reason: 'capture-dir-unset' });
    assert.match(String(listed?.message), /did not start \(capture-dir-unset\)/);
  } finally {
    await runtime.shutdown?.();
  }
});

function failedRequest(url: string): unknown {
  return {
    type: 'complete',
    sequence: 1,
    requestId: 'req-1',
    data: {
      startedDateTime: new Date(0).toISOString(),
      time: 0,
      request: { method: 'GET', url, httpVersion: 'HTTP/1.1', headers: [], cookies: [] },
      response: { status: 0, statusText: '', httpVersion: '', headers: [], cookies: [] },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
      _limrun: { tunnelId: 't1', selectorId: 's1', error: 'client_dial_failed' },
    },
  };
}

function androidLease(leaseId: string): DeviceLease {
  return {
    leaseId,
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

async function allocateAndroidDevice(
  runtime: ReturnType<typeof createLimrunRuntime>,
  leaseId = 'lease-appstate',
): Promise<DeviceInfo> {
  const allocation = await runtime.leaseLifecycle.allocate?.(androidLease(leaseId));
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
