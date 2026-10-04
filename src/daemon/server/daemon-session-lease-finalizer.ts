import type { DeviceLease } from '@agent-device/contracts/device';
import { leaseScopeToReleaseRequest } from '@agent-device/contracts/lease-scope';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { ExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { leaseReleaseRequestFor } from '../lease-registry-scope.ts';
import type { SessionState } from '../session-state.ts';

type DaemonLeaseFinalization = {
  leaseRegistry: LeaseRegistry;
  expiredProviderLeaseReleaser: ExpiredProviderLeaseReleaser;
  timeoutMs: number;
};

export async function finalizeDaemonSessionLease(
  params: DaemonLeaseFinalization & { session: SessionState },
): Promise<void> {
  const { session, leaseRegistry } = params;
  const sessionLease = session.lease;
  if (!sessionLease) return;
  let activeLease: DeviceLease | undefined;
  try {
    activeLease = leaseRegistry.getLease(
      leaseScopeToReleaseRequest({
        leaseId: sessionLease.leaseId,
        tenantId: sessionLease.tenantId,
        runId: sessionLease.runId,
        leaseBackend: sessionLease.leaseBackend,
        leaseProvider: sessionLease.leaseProvider,
        deviceKey: sessionLease.deviceKey,
        clientId: sessionLease.clientId,
      }),
    );
  } catch (error) {
    reportLeaseReleaseFailure(sessionLease.leaseId, session.name, error);
    return;
  }
  if (activeLease) await finalizeDaemonLease(params, activeLease, session.name);
}

/** Ends every lease no session holds, such as one allocated with `retainOnClose` whose session closed. */
export async function finalizeDaemonLeases(params: DaemonLeaseFinalization): Promise<void> {
  await Promise.all(
    params.leaseRegistry.listActiveLeases().map((lease) => finalizeDaemonLease(params, lease)),
  );
}

async function finalizeDaemonLease(
  params: DaemonLeaseFinalization,
  lease: DeviceLease,
  session?: string,
): Promise<void> {
  const { leaseRegistry, expiredProviderLeaseReleaser, timeoutMs } = params;
  try {
    const completed = await releaseWithinTimeout(
      expiredProviderLeaseReleaser.release(lease),
      timeoutMs,
    );
    leaseRegistry.releaseLease(leaseReleaseRequestFor(lease));
    if (!completed) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_shutdown_session_lease_release_timed_out',
        data: { session, leaseId: lease.leaseId, timeoutMs },
      });
    }
  } catch (error) {
    reportLeaseReleaseFailure(lease.leaseId, session, error);
  }
}

function reportLeaseReleaseFailure(
  leaseId: string,
  session: string | undefined,
  error: unknown,
): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'daemon_shutdown_session_lease_release_failed',
    data: { session, leaseId, error: error instanceof Error ? error.message : String(error) },
  });
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
