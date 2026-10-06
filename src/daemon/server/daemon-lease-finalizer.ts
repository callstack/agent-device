import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { ExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { leaseReleaseRequestFor } from '../lease-registry-scope.ts';

/**
 * Ends every lease still active at daemon shutdown, whether a session held it or its owner kept it
 * through `close` with `retainOnClose`. Each provider release is bounded by `timeoutMs`; one that
 * runs past it stays with the releaser for the shutdown drain.
 */
export async function finalizeDaemonLeases(params: {
  leaseRegistry: LeaseRegistry;
  expiredProviderLeaseReleaser: ExpiredProviderLeaseReleaser;
  timeoutMs: number;
}): Promise<void> {
  const { leaseRegistry, expiredProviderLeaseReleaser, timeoutMs } = params;
  await Promise.all(
    leaseRegistry.listActiveLeases().map(async (lease) => {
      try {
        const completed = await releaseWithinTimeout(
          expiredProviderLeaseReleaser.release(lease),
          timeoutMs,
        );
        leaseRegistry.releaseLease(leaseReleaseRequestFor(lease));
        if (!completed) {
          emitDiagnostic({
            level: 'warn',
            phase: 'daemon_shutdown_lease_release_timed_out',
            data: { leaseId: lease.leaseId, timeoutMs },
          });
        }
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'daemon_shutdown_lease_release_failed',
          data: {
            leaseId: lease.leaseId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }),
  );
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
