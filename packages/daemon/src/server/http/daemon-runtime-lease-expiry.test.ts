import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';

const leaseProbe = vi.hoisted(() => ({
  registries: [] as import('../../resources/lease-registry.ts').LeaseRegistry[],
  ended: [] as Array<[string, string]>,
  retryCalls: 0,
  shutdownSteps: [] as string[],
}));
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
import { startDaemonRuntime } from './daemon-runtime.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  leaseProbe.registries.length = 0;
  leaseProbe.ended.length = 0;
  leaseProbe.retryCalls = 0;
  leaseProbe.shutdownSteps.length = 0;
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

test('a lease that expires after shutdown is refused and reported, not sent to its provider', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-lease-closed-');
  const release = vi.fn(async (_lease: DeviceLease) => ({}));
  try {
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
    assert.notEqual(runtime, null);
    const [registry] = leaseProbe.registries;
    assert.ok(registry);
    const closing = runtime!.close();
    await vi.runOnlyPendingTimersAsync();
    await closing;

    // An abandoned request let this lease go past its TTL once this daemon had stopped releasing.
    const lease = registry.allocateLease({
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseProvider: 'browserstack',
      ttlMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    registry.consumeExpiredLease(lease.leaseId);
    await vi.advanceTimersByTimeAsync(0);

    // The provider was never asked, and the daemon log names the lease it could not end.
    assert.deepEqual(release.mock.calls, []);
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
              reason: 'closed',
              durable: false,
              leaseProvider: 'browserstack',
            }),
      ),
      `expected a refusal row in the daemon log, got ${JSON.stringify(rows.map((r) => r.phase))}`,
    );
  } finally {
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

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
