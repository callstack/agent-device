import { AppError } from '@agent-device/kernel/errors';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { readDaemonShutdownReport } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import { LEASE_REASONS } from '@agent-device/contracts/lease-scope';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';

const leaseProbe = vi.hoisted(() => ({
  registries: [] as import('../../resources/lease-registry.ts').LeaseRegistry[],
  ended: [] as Array<[string, string]>,
  retryCalls: 0,
  shutdownSteps: [] as string[],
  store: undefined as import('../../core/session-store.ts').SessionStore | undefined,
}));
vi.mock('../../core/session-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/session-store.ts')>();
  return {
    ...actual,
    SessionStore: class extends actual.SessionStore {
      constructor(...args: ConstructorParameters<typeof actual.SessionStore>) {
        super(...args);
        leaseProbe.store = this;
      }
    },
  };
});
vi.mock('../../resources/lease-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../resources/lease-registry.ts')>();
  class RecordedLeaseRegistry extends actual.LeaseRegistry {
    constructor(...args: ConstructorParameters<typeof actual.LeaseRegistry>) {
      super(...args);
      leaseProbe.registries.push(this);
    }
  }
  return { ...actual, LeaseRegistry: RecordedLeaseRegistry };
});
vi.mock('../lease-session-end.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lease-session-end.ts')>();
  return {
    ...actual,
    createLeaseSessionEnd: (options: Parameters<typeof actual.createLeaseSessionEnd>[0]) => {
      const ender = actual.createLeaseSessionEnd(options);
      return {
        ...ender,
        end: async (...args) => {
          leaseProbe.ended.push([args[0], args[1]]);
          await ender.end(...args);
        },
        retryPending: async () => {
          leaseProbe.retryCalls += 1;
          await ender.retryPending();
        },
        cancel: () => {
          leaseProbe.shutdownSteps.push('cancel');
          ender.cancel();
        },
        drain: async () => {
          leaseProbe.shutdownSteps.push('drain');
          await ender.drain();
        },
      } satisfies import('../lease-session-end.ts').LeaseSessionEnd;
    },
  };
});

import { SessionStore } from '../../core/session-store.ts';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { makeRecordingSession } from '../../__tests__/support/session-teardown.fixtures.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import type { DaemonRuntimeDeps } from './daemon-runtime-deps.ts';
import type { RpcBody } from './http-server-session-lease-touch.fixtures.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  leaseProbe.registries.length = 0;
  leaseProbe.ended.length = 0;
  leaseProbe.retryCalls = 0;
  leaseProbe.shutdownSteps.length = 0;
  leaseProbe.store = undefined;
});

function barrier() {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { reached, open };
}

const providerLease = {
  leaseProvider: 'limrun',
  leaseBackend: 'ios-instance',
  tenantId: 'tenant-a',
  runId: 'run-1',
  deviceKey: 'ios:mobile:fixture',
  ttlMs: 100,
} as const;

async function startProviderDaemon(deps: Partial<DaemonRuntimeDeps>) {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
  const stateDir = mkdtempForTestSync('agent-device-provider-lease-end-');
  const runtime = await startDaemonRuntime({
    composeDeps: daemonRuntimeDepsFixture({ providerRuntimeIds: ['limrun'], ...deps }),
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_LEASE_MIN_TTL_MS: '1',
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  assert.ok(runtime && leaseProbe.store && leaseProbe.registries[0]);
  return { runtime, registry: leaseProbe.registries[0], store: leaseProbe.store, stateDir };
}

async function heartbeatEnded(
  runtime: Awaited<ReturnType<typeof startProviderDaemon>>['runtime'],
  leaseId: string,
) {
  const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'heartbeat',
      method: 'agent_device.lease.heartbeat',
      params: {
        session: 'leased',
        leaseId,
        leaseProvider: providerLease.leaseProvider,
        deviceKey: providerLease.deviceKey,
        backend: providerLease.leaseBackend,
        tenantId: providerLease.tenantId,
        runId: providerLease.runId,
      },
    }),
  });
  const result = (await response.json()) as RpcBody;
  expect(result.error?.data?.details?.reason).toBe(LEASE_REASONS.instanceEnded.reason);
}

function endedInstance(): AppError {
  return new AppError('COMMAND_FAILED', 'Provider instance ended', {
    reason: LEASE_REASONS.instanceEnded.reason,
  });
}

async function closeProviderDaemon(
  runtime: Awaited<ReturnType<typeof startProviderDaemon>>['runtime'],
) {
  const shutdown = runtime.close();
  await vi.advanceTimersByTimeAsync(30_000);
  return await shutdown;
}

test('a provider-ended heartbeat disposes its exact lease once and keeps the reservation until disposal', async () => {
  const dispose = barrier();
  const release = vi.fn(async (_lease: DeviceLease) => {
    await dispose.reached;
    return undefined;
  });
  const { runtime, registry } = await startProviderDaemon({
    leaseLifecycleProvider: {
      heartbeat: async () => {
        throw endedInstance();
      },
      release,
    },
  });
  const lease = registry.allocateLease(providerLease);
  const successor = { ...providerLease, runId: 'run-2' };
  try {
    await heartbeatEnded(runtime, lease.leaseId);
    await vi.advanceTimersByTimeAsync(0);
    expect(release.mock.calls.map(([entry]) => entry.leaseId)).toEqual([lease.leaseId]);
    expect(() => registry.allocateLease(successor)).toThrow(
      expect.objectContaining({ code: 'DEVICE_IN_USE' }),
    );
    dispose.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.allocateLease(successor).leaseId).not.toBe(lease.leaseId);
  } finally {
    dispose.open();
    await closeProviderDaemon(runtime);
  }
});

test('a late provider-ended heartbeat settles the failed provider recording and waits for local cleanup', async () => {
  const entered = barrier();
  const reply = barrier();
  const release = vi.fn(async (_lease: DeviceLease) => undefined);
  let localStopReady = false;
  const { runtime, registry, store } = await startProviderDaemon({
    leaseLifecycleProvider: {
      heartbeat: async () => {
        entered.open();
        await reply.reached;
        throw endedInstance();
      },
      release,
    },
    platformResourceCleanup: platformResourceCleanupFixture({
      stopSnapshotHelper: async () => {
        if (!localStopReady) throw new Error('local helper still active');
      },
    }),
  });
  const lease = registry.allocateLease(providerLease);
  const finish = vi.fn(async () => {
    throw new Error('provider recorder disconnected');
  });
  store.publish('leased', {
    ...makeRecordingSession({
      name: 'leased',
      sessionStore: store,
      owner: providerRuntimeOwner('limrun', 'fixture'),
      finish,
      forceCleanup: async () => {
        throw new Error('provider recorder disconnected');
      },
    }),
    lease,
  });
  const heartbeat = heartbeatEnded(runtime, lease.leaseId);
  try {
    await Promise.race([entered.reached, heartbeat]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(finish).toHaveBeenCalledOnce();
    expect(registry.inspectActiveLease(lease.leaseId)).toBeUndefined();
    reply.open();
    await heartbeat;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release).not.toHaveBeenCalled();
    localStopReady = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release.mock.calls.map(([entry]) => entry.leaseId)).toEqual([lease.leaseId]);
    expect(Boolean(store.get('leased'))).toBe(false);
  } finally {
    reply.open();
    await heartbeat.catch(() => {});
    await closeProviderDaemon(runtime);
  }
});

test('shutdown releases expired leases after in-flight teardown and retained-host cleanup', async () => {
  const entered = barrier();
  const finish = barrier();
  const release = vi.fn(async (_lease: DeviceLease) => undefined);
  const cleanupSessionlessExecutionHost = vi.fn(async () => {});
  const { runtime, registry, store } = await startProviderDaemon({
    leaseLifecycleProvider: { release },
    platformResourceCleanup: platformResourceCleanupFixture({
      cleanupSessionlessExecutionHost,
      stopSnapshotHelper: async () => {
        entered.open();
        await finish.reached;
      },
    }),
  });
  const lease = registry.allocateLease(providerLease);
  store.publish('leased', { ...makeIosSession('leased'), lease });
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    await entered.reached;
    const retainedLease = registry.allocateLease({
      ...providerLease,
      runId: 'retained',
      deviceKey: 'ios:mobile:retained',
    });
    const retained = store.publish('retained', {
      ...makeIosSession('retained'),
      lease: retainedLease,
    });
    store.retire(retained, { retainExecutionHost: true });
    vi.setSystemTime(retainedLease.expiresAt);
    const shutdown = closeProviderDaemon(runtime);
    finish.open();
    await shutdown;
    expect(release.mock.calls.map(([entry]) => entry.leaseId)).toEqual([
      lease.leaseId,
      retainedLease.leaseId,
    ]);
    expect(cleanupSessionlessExecutionHost).toHaveBeenCalledExactlyOnceWith(
      retained.session.device,
    );
    const [hostStopped] = cleanupSessionlessExecutionHost.mock.invocationCallOrder;
    const [, providerReleased] = release.mock.invocationCallOrder;
    assert.ok(hostStopped !== undefined && providerReleased !== undefined);
    expect(hostStopped).toBeLessThan(providerReleased);
  } finally {
    finish.open();
    await closeProviderDaemon(runtime);
  }
});

test('shutdown releases an expired rental whose local teardown failed', async () => {
  const release = vi.fn(async (_lease: DeviceLease) => undefined);
  const stopSnapshotHelper = vi.fn(async () => {
    throw new Error('snapshot helper still active');
  });
  const { runtime, registry, store, stateDir } = await startProviderDaemon({
    leaseLifecycleProvider: { release },
    platformResourceCleanup: platformResourceCleanupFixture({ stopSnapshotHelper }),
  });
  const lease = registry.allocateLease(providerLease);
  store.publish('leased', { ...makeIosSession('leased'), lease });
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopSnapshotHelper).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    const report = await closeProviderDaemon(runtime);
    expect(release.mock.calls.map(([entry]) => entry.leaseId)).toEqual([lease.leaseId]);
    const failure = { leaseId: lease.leaseId, failedSteps: ['platform_snapshot_helper'] };
    const reportFields = { leaseCleanupFailures: [failure] };
    expect(report).toMatchObject(reportFields);
    expect(readDaemonShutdownReport(stateDir)).toMatchObject(reportFields);
    const diagnostics = fs
      .readFileSync(`${stateDir}/daemon.log`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        phase: 'leased_session_ended',
        data: expect.objectContaining({ ...failure, reason: 'DAEMON_SHUTDOWN', session: 'leased' }),
      }),
    );
  } finally {
    await closeProviderDaemon(runtime);
  }
});

test('an expired lease ends its session without any further request', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-lease-expiry-');
  try {
    const runtime = await startDaemonRuntime({
      composeDeps: daemonRuntimeDepsFixture(),
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
          AGENT_DEVICE_LEASE_MIN_TTL_MS: '1',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);
    const [registry] = leaseProbe.registries;
    const lease = registry!.allocateLease({ tenantId: 'tenant-a', runId: 'run-1', ttlMs: 50 });

    await vi.advanceTimersByTimeAsync(40);
    assert.deepEqual(leaseProbe.ended, []);

    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(leaseProbe.ended, [[lease.leaseId, 'LEASE_EXPIRED']]);
    assert.equal(leaseProbe.retryCalls, 1);

    const shutdown = runtime?.close();
    await vi.runOnlyPendingTimersAsync();
    await shutdown;
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test.each(['closed', 'provider-runtime-unavailable'] as const)(
  'a non-durable provider refusal (%s) reports unknown release and keeps the reservation',
  async (reason) => {
    vi.useFakeTimers();
    const stateDir = mkdtempForTestSync('agent-device-daemon-lease-closed-');
    const release = vi.fn(async (_lease: DeviceLease) => ({}));
    let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> | undefined;
    try {
      runtime = await startDaemonRuntime({
        composeDeps: daemonRuntimeDepsFixture({
          leaseLifecycleProvider: { release },
          providerRuntimeIds: reason === 'closed' ? ['browserstack'] : [],
        }),
        host: createTestHostEnvironment({
          env: {
            ...process.env,
            AGENT_DEVICE_STATE_DIR: stateDir,
            AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
            AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
            AGENT_DEVICE_LEASE_MIN_TTL_MS: '1',
          },
        }),
        stderr: { write: () => {} },
        stdout: { write: () => {} },
      });
      assert.notEqual(runtime, null);
      const [registry] = leaseProbe.registries;
      assert.ok(registry);
      if (reason === 'closed') {
        const closing = runtime!.close();
        await vi.runOnlyPendingTimersAsync();
        await closing;
      }

      const request = {
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseProvider: 'browserstack',
        deviceKey: 'fixture-device',
        ttlMs: 10,
      };
      const lease = registry.allocateLease(request);
      await vi.advanceTimersByTimeAsync(1_000);
      registry.consumeExpiredLease(lease.leaseId);
      await vi.advanceTimersByTimeAsync(0);

      // The provider was never asked, and the daemon log names the lease it could not end.
      assert.deepEqual(release.mock.calls, []);
      const next = { ...request, runId: 'run-2' };
      assert.throws(
        () => registry.allocateLease(next),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'DEVICE_IN_USE');
          assert.equal(error.details?.reason, 'DEVICE_LEASE_BUSY');
          assert.equal(error.details?.releaseStatus, 'unknown');
          return true;
        },
      );
      assert.ok(registry.allocateLease({ ...next, deviceKey: 'other-device' }).leaseId);
      const rows = fs
        .readFileSync(`${stateDir}/daemon.log`, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { phase: string; level: string; data?: unknown });
      assert.ok(
        rows.some(
          (row) =>
            row.phase === 'provider_lease_release_refused' &&
            row.level === 'error' &&
            JSON.stringify(row.data) ===
              JSON.stringify({
                leaseId: lease.leaseId,
                reason,
                durable: false,
                leaseProvider: 'browserstack',
              }),
        ),
        `expected a refusal row in the daemon log, got ${JSON.stringify(rows.map((r) => r.phase))}`,
      );
    } finally {
      vi.useRealTimers();
      await runtime?.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

test('expiry reserves the provider device through a slow failed release and a successful retry', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-provider-expiry-reservation-');
  let failFirstRelease!: (error: Error) => void;
  const firstRelease = new Promise<never>((_resolve, reject) => {
    failFirstRelease = reject;
  });
  const release = vi
    .fn(async (_lease: DeviceLease) => ({}))
    .mockImplementationOnce(async () => await firstRelease);
  const runtime = await startDaemonRuntime({
    composeDeps: daemonRuntimeDepsFixture({
      leaseLifecycleProvider: { release },
      providerRuntimeIds: ['browserstack'],
    }),
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_LEASE_MIN_TTL_MS: '1',
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  assert.ok(runtime);
  const [registry] = leaseProbe.registries;
  assert.ok(registry);
  const request = {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'browserstack',
    deviceKey: 'fixture-device',
    ttlMs: 10,
  };
  const lease = registry.allocateLease(request);
  const next = { ...request, runId: 'run-2' };
  const assertBusy = () =>
    assert.throws(() => registry.allocateLease(next), {
      code: 'DEVICE_IN_USE',
    });
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(release.mock.calls.length, 1);
    assertBusy();
    failFirstRelease(new Error('provider temporarily unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    assertBusy();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(release.mock.calls.length, 2);
    assert.notEqual(registry.allocateLease(next).leaseId, lease.leaseId);
  } finally {
    vi.useRealTimers();
    await runtime.close();
  }
});

test('shutdown cancels and drains lease ends before it tears sessions down', async () => {
  const closeAdmission = SessionStore.prototype.closeAdmission;
  vi.spyOn(SessionStore.prototype, 'closeAdmission').mockImplementation(
    function (this: SessionStore) {
      leaseProbe.shutdownSteps.push('teardown');
      closeAdmission.call(this);
    },
  );
  const stateDir = mkdtempForTestSync('agent-device-daemon-lease-shutdown-');
  try {
    const runtime = await startDaemonRuntime({
      composeDeps: daemonRuntimeDepsFixture(),
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);

    await runtime?.close();

    assert.deepEqual(leaseProbe.shutdownSteps, ['cancel', 'drain', 'teardown']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
