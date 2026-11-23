import { AppError } from '@agent-device/kernel/errors';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { acquireDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { retainOrphanedDeviceClaims } from '../../__tests__/support/device-claim-store.ts';
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
import {
  applicationLifecycleResourceFixture,
  daemonRuntimeDepsFixture,
} from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { applicationLifecycleRuntimeFixture } from '../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import { createLifecycleDeviceRuntimeGatewaySpies } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { makeRecordingSession } from '../../__tests__/support/session-teardown.fixtures.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import type { DaemonRuntimeDeps } from './daemon-runtime-deps.ts';
import type { RpcBody } from './http-server-session-lease-touch.fixtures.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';
import {
  mkdtempForTestSync,
  createTestHostEnvironment,
  deviceClaimFilePath,
} from '@agent-device/test-kit';

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

async function startProviderDaemon(deps: Partial<DaemonRuntimeDeps>, inheritedLease?: DeviceLease) {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
  const stateDir = mkdtempForTestSync('agent-device-provider-lease-end-');
  if (inheritedLease)
    fs.writeFileSync(
      `${stateDir}/live-provider-leases.json`,
      JSON.stringify({
        version: 1,
        leases: [inheritedLease],
      }),
    );
  const runtime = await startDaemonRuntime({
    composeDeps: daemonRuntimeDepsFixture({ providerRuntimeIds: ['limrun'], ...deps }),
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_CLAIMS_DIR: `${stateDir}/claims`,
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

async function leaseRpc(
  runtime: Awaited<ReturnType<typeof startProviderDaemon>>['runtime'],
  method: 'allocate' | 'release' | 'close',
  params: Record<string, unknown> = {},
): Promise<RpcBody> {
  const scope = { ...providerLease, backend: providerLease.leaseBackend, ...params };
  const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
    method: 'POST',
    headers: {
      connection: 'close',
      authorization: `Bearer ${runtime.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method: method === 'close' ? 'agent_device.command' : `agent_device.lease.${method}`,
      params:
        method === 'close'
          ? { session: 'leased', command: 'close', positionals: [], meta: scope }
          : { session: 'leased', ...scope },
    }),
  });
  return (await response.json()) as RpcBody;
}

test('host DELETE ends logical leases and keeps refused provider releases fenced', async () => {
  const release = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ release: 'unknown' })
    .mockResolvedValueOnce({ release: 'confirmed' });
  const { runtime, registry } = await startProviderDaemon({ leaseLifecycleProvider: { release } });
  const logical = registry.allocateLease({ ...providerLease, leaseProvider: 'proxy' });
  const rental = registry.allocateLease(providerLease);
  const remove = async (leaseId: string) => {
    const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/admin/leases/${leaseId}`, {
      method: 'DELETE',
      headers: { connection: 'close', authorization: `Bearer ${runtime.token}` },
    });
    return await response.json();
  };
  try {
    expect(await remove(logical.leaseId)).toMatchObject({ ok: true, released: true });
    expect(await remove(rental.leaseId)).toMatchObject({
      ok: true,
      released: false,
      releaseStatus: 'unknown',
      releaseReason: 'provider-release-unconfirmed',
    });
    expect(() => registry.allocateLease(providerLease)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'DEVICE_LEASE_BUSY', releaseStatus: 'unknown' }),
      }),
    );
    expect(await remove(rental.leaseId)).toMatchObject({ ok: true, released: true });
    expect(release.mock.calls.map(([lease]) => lease.leaseId)).toEqual([
      logical.leaseId,
      rental.leaseId,
      rental.leaseId,
    ]);
  } finally {
    await closeProviderDaemon(runtime);
  }
});

test.each(['keyed first', 'keyless first', 'both keyed'] as const)(
  'allocation fences keyed and keyless overlap while creating (%s)',
  async (order) => {
    const entered = barrier();
    const created = barrier();
    const allocate = vi.fn(async () => {
      if (allocate.mock.calls.length === 1) {
        entered.open();
        await created.reached;
      }
      return {};
    });
    const { runtime } = await startProviderDaemon({
      leaseLifecycleProvider: { allocate, release: async () => ({ release: 'confirmed' }) },
    });
    const first = leaseRpc(runtime, 'allocate', {
      deviceKey: order === 'keyless first' ? undefined : providerLease.deviceKey,
    });
    try {
      await entered.reached;
      const overlap = await leaseRpc(runtime, 'allocate', {
        deviceKey: order === 'keyed first' ? undefined : providerLease.deviceKey,
      });
      expect(overlap.error?.data?.details).toMatchObject({
        reason: 'provider-allocation-in-progress',
      });
      expect(overlap.error?.data?.details).not.toHaveProperty('releaseStatus');
      expect(overlap.error?.data?.details).not.toHaveProperty('releaseReason');
      expect(allocate).toHaveBeenCalledTimes(1);
    } finally {
      created.open();
      await first;
      await closeProviderDaemon(runtime);
    }
  },
);

test('same-ID allocation cannot renew while an explicit release is awaiting its provider reply', async () => {
  const entered = barrier();
  const answer = barrier();
  const release = vi.fn(async () => {
    entered.open();
    await answer.reached;
    return { release: 'confirmed' as const };
  });
  const { runtime, registry } = await startProviderDaemon({
    leaseLifecycleProvider: { release },
  });
  const leaseId = 'aabbccddaabbccddaabbccddaabbccdd';
  registry.allocateLease({ ...providerLease, leaseId });
  const ending = leaseRpc(runtime, 'release', { leaseId });
  try {
    await entered.reached;
    const overlap = await leaseRpc(runtime, 'allocate', { leaseId });
    expect(overlap.error?.data?.details).toMatchObject({
      reason: 'DEVICE_LEASE_BUSY',
      releaseStatus: 'unknown',
    });
  } finally {
    answer.open();
    await ending;
    await closeProviderDaemon(runtime);
  }
});

test('a close retry admits the ending lease owner without renewing it', async () => {
  const release = vi
    .fn()
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'provider has not confirmed release'))
    .mockResolvedValue({ release: 'confirmed' });
  const { runtime, registry, store } = await startProviderDaemon({
    leaseLifecycleProvider: { release },
  });
  const lease = registry.allocateLease(providerLease);
  store.publish('leased', makeIosSession('leased', { lease }));
  const close = () => leaseRpc(runtime, 'close', { leaseId: lease.leaseId });
  try {
    expect(await close()).toMatchObject({ error: { data: { code: 'COMMAND_FAILED' } } });
    expect(registry.inspectActiveLease(lease.leaseId)).toBeUndefined();
    expect((await close()).result?.ok).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
    await closeProviderDaemon(runtime);
  }
});

test('an inherited scope is refused as release unknown when its runtime is missing', async () => {
  const lease: DeviceLease = {
    ...providerLease,
    backend: providerLease.leaseBackend,
    leaseId: 'aabbccddaabbccddaabbccddaabbccdd',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 2,
  };
  const { runtime } = await startProviderDaemon({ providerRuntimeIds: [] }, lease);
  try {
    const refused = await leaseRpc(runtime, 'allocate');
    expect(refused.error?.data?.details).toMatchObject({
      reason: 'DEVICE_LEASE_BUSY',
      releaseStatus: 'unknown',
      releaseReason: 'provider-runtime-unavailable',
    });
  } finally {
    await closeProviderDaemon(runtime);
  }
});

test.each(['confirmed', 'unknown'] as const)(
  'explicit release reports an unattributable claim with provider release %s',
  async (providerRelease) => {
    const { runtime, registry, store, stateDir } = await startProviderDaemon({
      leaseLifecycleProvider: { release: async () => ({ release: providerRelease }) },
    });
    const lease = registry.allocateLease(providerLease);
    const session = makeIosSession('leased', { lease });
    const env = { ...process.env, AGENT_DEVICE_CLAIMS_DIR: `${stateDir}/claims` };
    vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', env.AGENT_DEVICE_CLAIMS_DIR);
    try {
      const claim = await acquireDeviceClaim({
        env,
        device: session.device,
        session: session.name,
        workspace: stateDir,
        stateDir,
        reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
      });
      assert.equal(claim.status, 'acquired');
      if (claim.status !== 'acquired') return;
      store.publish('leased', { ...session, deviceClaim: claim.ownership });
      fs.writeFileSync(deviceClaimFilePath(claim.ownership.deviceKey), '{corrupt');
      const release = await leaseRpc(runtime, 'release', { leaseId: lease.leaseId });
      expect(release.error).toBeUndefined();
      expect(release.result?.data).toMatchObject({
        released: false,
        releaseStatus: 'unknown',
        releaseReason: 'device-claim-release-unconfirmed',
      });
      expect((await leaseRpc(runtime, 'allocate')).error?.data?.details).toMatchObject({
        releaseStatus: 'unknown',
        releaseReason: 'device-claim-release-unconfirmed',
      });
    } finally {
      vi.unstubAllEnvs();
      await closeProviderDaemon(runtime);
    }
  },
);

test('a provider-ended heartbeat fences its exact lease through disposal refusal and retry', async () => {
  const dispose = barrier();
  const release = vi.fn(async (_lease: DeviceLease) => {
    if (release.mock.calls.length === 1) {
      await dispose.reached;
      throw new Error('temporary disposal refusal');
    }
    return { release: 'confirmed' as const };
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
    expect(() => registry.allocateLease(successor)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ releaseStatus: 'unknown' }),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(release.mock.calls.map(([entry]) => entry.leaseId)).toEqual([
      lease.leaseId,
      lease.leaseId,
    ]);
    expect(registry.allocateLease(successor).leaseId).not.toBe(lease.leaseId);
  } finally {
    dispose.open();
    await closeProviderDaemon(runtime);
  }
});

test.each([false, true])(
  'a late provider end prevents further recording calls with an in-flight finish=%s',
  async (inFlight) => {
    const entered = barrier();
    const reply = barrier();
    const stop = barrier();
    const release = vi.fn(async (_lease: DeviceLease) => ({ release: 'confirmed' as const }));
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
      if (inFlight) await stop.reached;
      throw new Error('provider recorder disconnected');
    });
    const forceCleanup = vi.fn(async () => {
      throw new Error('provider recorder disconnected');
    });
    store.publish('leased', {
      ...makeRecordingSession({
        name: 'leased',
        sessionStore: store,
        owner: providerRuntimeOwner('limrun', 'fixture'),
        finish,
        forceCleanup,
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
      stop.open();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(release).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalledOnce();
      expect(forceCleanup).toHaveBeenCalledTimes(inFlight ? 0 : 1);
      localStopReady = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(release.mock.calls.map(([entry]) => entry.leaseId)).toEqual([lease.leaseId]);
      expect(Boolean(store.get('leased'))).toBe(false);
    } finally {
      reply.open();
      stop.open();
      await heartbeat.catch(() => {});
      await closeProviderDaemon(runtime);
    }
  },
);

test('shutdown releases expired leases after in-flight teardown and retained-host cleanup', async () => {
  const entered = barrier();
  const finish = barrier();
  const release = vi.fn(async (_lease: DeviceLease) => ({ release: 'confirmed' as const }));
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

test('expiry clears the hints for the app they were set for once across cleanup retries', async () => {
  const release = vi.fn(async (_lease: DeviceLease) => ({ release: 'confirmed' as const }));
  const clearRuntimeHints = vi.fn(async () => {});
  const { gateway, bind } = createLifecycleDeviceRuntimeGatewaySpies(async (device, signal) => ({
    ...(await applicationLifecycleRuntimeFixture(device, signal)),
    clearRuntimeHints,
  }));
  const bindRuntime = bind.getMockImplementation()!;
  bind.mockImplementationOnce(async (input) => ({
    ...(await bindRuntime(input)),
    [Symbol.asyncDispose]: async () => {
      throw new Error('binding disposal failed');
    },
  }));
  const { runtime, registry, store } = await startProviderDaemon({
    deviceRuntimeGateway: {
      ...gateway,
      applicationLifecycle: applicationLifecycleResourceFixture(),
    },
    leaseLifecycleProvider: { release },
  });
  const lease = registry.allocateLease(providerLease);
  store.publish('leased', {
    ...makeIosSession('leased'),
    appBundleId: 'com.example.active',
    lease,
  });
  store.setRuntimeHints(
    'leased',
    { metroHost: 'scoped.example', metroPort: 8082 },
    'com.example.bound',
  );
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release.mock.calls.map(([entry]) => entry.leaseId)).toEqual([lease.leaseId]);
    expect(clearRuntimeHints).toHaveBeenCalledExactlyOnceWith({
      appId: 'com.example.bound',
      values: { metroHost: 'scoped.example', metroPort: '8082' },
    });
  } finally {
    await closeProviderDaemon(runtime);
  }
});

test('shutdown releases an expired rental whose local teardown failed', async () => {
  const release = vi.fn(async (_lease: DeviceLease) => ({ release: 'confirmed' as const }));
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
    const release = vi.fn(async (_lease: DeviceLease) => ({ release: 'confirmed' as const }));
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
    .fn(async (_lease: DeviceLease) => ({ release: 'confirmed' as const }))
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
    expect(() => registry.allocateLease(next)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          releaseStatus: 'unknown',
          releaseReason: 'provider-release-unconfirmed',
        }),
      }),
    );
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
