import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { LeaseRegistry, type DeviceLease } from '../lease-registry.ts';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { finalizeDaemonSessionLease } from './daemon-session-lease-finalizer.ts';

test('journals and bounds a hung recoverable session lease release before the final drain', async () => {
  vi.useFakeTimers();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-lease-finalizer-'));
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });
  const recoverExpiredLease = vi.fn(() => new Promise<void>(() => {}));
  const expiredProviderLeaseReleaser = createExpiredProviderLeaseReleaser({
    recoverExpiredLease,
    recoverableProviderIds: ['limrun'],
    stateDir,
  });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      expiresAt: lease.expiresAt,
    },
  });

  try {
    expiredProviderLeaseReleaser.beginShutdown();
    const finalization = finalizeDaemonSessionLease({
      session,
      leaseRegistry,
      expiredProviderLeaseReleaser,
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await finalization;

    expect(recoverExpiredLease).toHaveBeenCalledWith(lease);
    expect(leaseRegistry.listActiveLeases()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'expired-provider-leases.json'))).toBe(true);
    const drain = expiredProviderLeaseReleaser.drain(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(drain).resolves.toEqual({
      pending: [lease],
      released: [],
    });
  } finally {
    expiredProviderLeaseReleaser.shutdown();
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('final drain joins a release that completes after the session timeout', async () => {
  vi.useFakeTimers();
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'browserstack',
  });
  const release = vi.fn(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        setTimeout(() => resolve({}), 1_500);
      }),
  );
  const expiredProviderLeaseReleaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: { release },
    providerRuntimeIds: ['browserstack'],
  });
  const session = makeIosSession('default', {
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      expiresAt: lease.expiresAt,
    },
  });

  try {
    expiredProviderLeaseReleaser.beginShutdown();
    const finalization = finalizeDaemonSessionLease({
      session,
      leaseRegistry,
      expiredProviderLeaseReleaser,
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await finalization;
    const drain = expiredProviderLeaseReleaser.drain(2_000);

    await vi.advanceTimersByTimeAsync(500);
    await expect(drain).resolves.toEqual({ pending: [], released: [lease] });
  } finally {
    expiredProviderLeaseReleaser.shutdown();
    vi.useRealTimers();
  }
});

test('a hung provider release does not starve a later session during shutdown', async () => {
  vi.useFakeTimers();
  const leaseRegistry = new LeaseRegistry();
  const hungLease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'browserstack',
  });
  const releasedLease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-2',
    leaseProvider: 'browserstack',
  });
  const release = vi.fn((lease: DeviceLease) =>
    lease.leaseId === hungLease.leaseId
      ? new Promise<Record<string, unknown>>(() => {})
      : Promise.resolve({}),
  );
  const expiredProviderLeaseReleaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: { release },
    providerRuntimeIds: ['browserstack'],
  });
  const sessions = [
    makeIosSession('hung', { lease: sessionLease(hungLease) }),
    makeIosSession('released', { lease: sessionLease(releasedLease) }),
  ];

  try {
    expiredProviderLeaseReleaser.beginShutdown();
    const finalization = Promise.all(
      sessions.map(
        async (session) =>
          await finalizeDaemonSessionLease({
            session,
            leaseRegistry,
            expiredProviderLeaseReleaser,
            timeoutMs: 1_000,
          }),
      ),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await finalization;

    expect(release).toHaveBeenCalledWith(hungLease);
    expect(release).toHaveBeenCalledWith(releasedLease);
    expect(leaseRegistry.listActiveLeases()).toEqual([]);
    const drain = expiredProviderLeaseReleaser.drain(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(drain).resolves.toEqual({ pending: [hungLease], released: [releasedLease] });
  } finally {
    expiredProviderLeaseReleaser.shutdown();
    vi.useRealTimers();
  }
});

function sessionLease(lease: DeviceLease) {
  return {
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.backend,
    leaseProvider: lease.leaseProvider,
    expiresAt: lease.expiresAt,
  };
}
