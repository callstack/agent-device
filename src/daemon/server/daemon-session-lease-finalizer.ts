import { leaseScopeToReleaseRequest } from '../../core/lease-scope.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { ExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import type { SessionState } from '../types.ts';

export async function finalizeDaemonSessionLease(params: {
  session: SessionState;
  leaseRegistry: LeaseRegistry;
  expiredProviderLeaseReleaser: ExpiredProviderLeaseReleaser;
  timeoutMs: number;
}): Promise<void> {
  const { session, leaseRegistry, expiredProviderLeaseReleaser, timeoutMs } = params;
  if (!session.lease) return;
  try {
    const releaseRequest = leaseScopeToReleaseRequest({
      leaseId: session.lease.leaseId,
      tenantId: session.lease.tenantId,
      runId: session.lease.runId,
      leaseBackend: session.lease.leaseBackend,
      leaseProvider: session.lease.leaseProvider,
      deviceKey: session.lease.deviceKey,
      clientId: session.lease.clientId,
    });
    const activeLease = leaseRegistry.getLease(releaseRequest);
    if (!activeLease) return;
    const completed = await releaseWithinTimeout(
      expiredProviderLeaseReleaser.release(activeLease),
      timeoutMs,
    );
    leaseRegistry.releaseLease(releaseRequest);
    if (!completed) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_shutdown_session_lease_release_timed_out',
        data: {
          session: session.name,
          leaseId: session.lease.leaseId,
          timeoutMs,
        },
      });
    }
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'daemon_shutdown_session_lease_release_failed',
      data: {
        session: session.name,
        leaseId: session.lease.leaseId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function releaseWithinTimeout(release: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void release.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
