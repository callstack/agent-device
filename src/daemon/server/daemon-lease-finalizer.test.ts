import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { LeaseRegistry } from '../lease-registry.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { finalizeDaemonLeases } from './daemon-lease-finalizer.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('journals and bounds a hung recoverable lease release before the final drain', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-lease-finalizer-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
    retainOnClose: true,
  });
  const recoverExpiredLease = vi.fn(() => new Promise<void>(() => {}));
  const expiredProviderLeaseReleaser = createExpiredProviderLeaseReleaser({
    recoverExpiredLease,
    recoverableProviderIds: ['limrun'],
    stateDir,
  });

  try {
    expiredProviderLeaseReleaser.beginShutdown();
    const finalization = finalizeDaemonLeases({
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

test('final drain joins a release that completes after the lease timeout', async () => {
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

  try {
    expiredProviderLeaseReleaser.beginShutdown();
    const finalization = finalizeDaemonLeases({
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

test('a hung provider release does not starve another lease during shutdown', async () => {
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

  try {
    expiredProviderLeaseReleaser.beginShutdown();
    const finalization = finalizeDaemonLeases({
      leaseRegistry,
      expiredProviderLeaseReleaser,
      timeoutMs: 1_000,
    });

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
