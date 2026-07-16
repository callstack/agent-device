import { expect, test, vi } from 'vitest';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { LeaseRegistry } from '../lease-registry.ts';

test('retries an expired provider lease release after a transient failure', async () => {
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
    leaseProvider: 'limrun',
  });
  const release = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('temporary provider outage'))
    .mockResolvedValueOnce({ limrunInstanceId: 'instance-1' });
  const releaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: { release },
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
