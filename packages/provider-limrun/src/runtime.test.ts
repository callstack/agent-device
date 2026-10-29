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
  captureTunnelClose: vi.fn(),
  onInspectionEvent: undefined as ((event: unknown) => void) | undefined,
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
    startTunnel: vi.fn(async (options: { onInspectionEvent: (event: unknown) => void }) => {
      state.onInspectionEvent = options.onInspectionEvent;
      return { tunnelId: 't1', selectors: [], close: state.captureTunnelClose };
    }),
    getTunnelStatus: vi.fn(async () => ({
      lastDialFailure: { tunnelId: 't1', reason: 'dns_not_found' },
    })),
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

test('a network capture writes a private HAR with its failures on artifacts and at release', async () => {
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: mkdtempForTestSync('limrun-har-') },
    testDependencies(),
  );
  const lease = androidLease('lease-capture');
  try {
    // A repeat allocation of the live lease starts the capture it newly asks for.
    await runtime.leaseLifecycle.allocate?.(lease);
    await runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } });
    for (let index = 0; index < 500; index += 1) {
      state.onInspectionEvent?.(completedRequest(`https://api.example.com/${index}`));
    }
    state.onInspectionEvent?.(
      completedRequest('https://missing.example.com/', 'client_dial_failed'),
    );

    const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
    const harPath = String(listed?.cloudArtifacts[0]?.url);
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    assert.equal(har.log.entries.length, 500);
    assert.equal(har.log.entries.at(-1).response.status, 0);
    assert.equal(fs.statSync(harPath).mode & 0o777, 0o600);
    assert.deepEqual(listed?.cloudArtifacts[0]?.metadata, {
      failures: {
        count: 2,
        last: { kind: 'request-failed', host: 'missing.example.com', port: 443 },
        lastDialFailure: 'dns_not_found',
      },
    });

    const released = (await runtime.leaseLifecycle.release?.(lease)) as {
      cloudArtifacts?: { cloudArtifacts: { url?: string }[]; message?: string };
    };
    assert.equal(released.cloudArtifacts?.cloudArtifacts[0]?.url, harPath);
    assert.equal(state.captureTunnelClose.mock.calls.length, 1);
    assert.match(
      String(released.cloudArtifacts?.message),
      /last request-failed missing\.example\.com:443/,
    );
    const afterClose = await runtime.cloudArtifacts?.listCloudArtifacts?.({
      leaseId: lease.leaseId,
    });
    assert.equal(afterClose?.cloudArtifacts[0]?.url, harPath);
  } finally {
    await runtime.shutdown();
  }
});

test('a network capture that cannot start is an unavailable artifact with its typed reason', async () => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-no-dir');
  try {
    await runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } });
    const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
    assert.equal(listed?.status, 'unavailable');
    assert.deepEqual(listed?.cloudArtifacts[0]?.metadata, { reason: 'capture-dir-unset' });
  } finally {
    await runtime.shutdown();
  }
});

function completedRequest(url: string, error?: string): unknown {
  return {
    type: 'complete',
    sequence: 1,
    requestId: url,
    data: {
      startedDateTime: new Date(0).toISOString(),
      time: 0,
      request: { method: 'GET', url, httpVersion: 'HTTP/1.1', headers: [], cookies: [] },
      response: {
        status: error ? 0 : 200,
        statusText: '',
        httpVersion: '',
        headers: [],
        cookies: [],
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
      _limrun: { tunnelId: 't1', selectorId: 's1', ...(error ? { error } : {}) },
    },
  };
}

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
  const allocation = await runtime.leaseLifecycle.allocate?.(androidLease(leaseId));
  const device = allocation?.device;
  if (!device || typeof device !== 'object') throw new Error('Expected allocated device');
  return device as DeviceInfo;
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
