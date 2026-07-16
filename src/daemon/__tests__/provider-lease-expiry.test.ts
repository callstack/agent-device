import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { LeaseRegistry, type DeviceLease } from '../lease-registry.ts';

test('retries an expired live-only provider lease release after a transient failure', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const leaseRegistry = new LeaseRegistry({
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
  });
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'browserstack',
  });
  const release = vi
    .fn<(lease: DeviceLease) => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('temporary provider outage'))
    .mockResolvedValueOnce({ limrunInstanceId: 'instance-1' });
  const releaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: { release },
    providerRuntimeIds: ['browserstack'],
    retryDelayMs: 10,
  });

  try {
    now = 1_011;
    const expiredLease = leaseRegistry.consumeExpiredLease(lease.leaseId);
    expect(expiredLease).toEqual(lease);
    await releaser.release(expiredLease!);
    expect(release).toHaveBeenCalledTimes(1);
    expect(leaseRegistry.listActiveLeases()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith(lease);
  } finally {
    releaser.shutdown();
    vi.useRealTimers();
  }
});

test('retries a persisted expired provider lease after daemon restart', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-expired-provider-lease-'));
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });
  const release = vi
    .fn<(lease: DeviceLease) => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('temporary provider outage'))
    .mockResolvedValueOnce({ limrunInstanceId: 'instance-1' });
  const options = {
    recoverExpiredLease: async (expiredLease: typeof lease) => {
      await release(expiredLease);
    },
    stateDir,
    recoverableProviderIds: ['limrun'],
  };
  const firstDaemon = createExpiredProviderLeaseReleaser(options);

  try {
    await firstDaemon.release(lease);
    expect(release).toHaveBeenCalledTimes(1);
    firstDaemon.shutdown();

    const daemonWithoutLimrun = createExpiredProviderLeaseReleaser({
      ...options,
      recoverableProviderIds: [],
    });
    await daemonWithoutLimrun.retryPending();
    expect(release).toHaveBeenCalledTimes(1);
    daemonWithoutLimrun.shutdown();

    const restartedDaemon = createExpiredProviderLeaseReleaser(options);
    await restartedDaemon.retryPending();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith(lease);
    restartedDaemon.shutdown();
  } finally {
    firstDaemon.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('does not release until the expired lease record is durable', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-expired-provider-lease-'));
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });
  const recoverExpiredLease = vi.fn(async () => undefined);
  const releaser = createExpiredProviderLeaseReleaser({
    recoverExpiredLease,
    stateDir,
    recoverableProviderIds: ['limrun'],
    retryDelayMs: 60_000,
  });
  const writeFile = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw new Error('disk full');
  });

  try {
    await releaser.release(lease);
    expect(recoverExpiredLease).not.toHaveBeenCalled();

    writeFile.mockRestore();
    await releaser.retryPending();
    expect(recoverExpiredLease).toHaveBeenCalledWith(lease);
  } finally {
    writeFile.mockRestore();
    releaser.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
