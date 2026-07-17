import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { LeaseRegistry } from '../lease-registry.ts';
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
    await expect(expiredProviderLeaseReleaser.drain(10)).resolves.toEqual({
      pending: [lease],
      released: [],
    });
  } finally {
    expiredProviderLeaseReleaser.shutdown();
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
