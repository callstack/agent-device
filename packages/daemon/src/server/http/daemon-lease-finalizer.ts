import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceLease } from '@agent-device/contracts/device';
import {
  leaseReleaseDiagnosticEvent,
  type ExpiredProviderLeaseReleaser,
  type ProviderLeaseReleaseOutcome,
} from '../provider-lease-expiry.ts';
import type { LeaseRegistry } from '../../resources/lease-registry.ts';
import { leaseReleaseRequestFor } from '../../resources/lease-registry-scope.ts';

/**
 * The leases this finalizer was refused, by id. The shutdown summary reports these: a release its
 * provider never saw is not a release this daemon completed.
 */
export type DaemonLeaseReleaseSummary = Readonly<{
  refused: readonly string[];
}>;

/** What one lease came to here. The lease travels with it: the report must name it whichever way this went. */
type LeaseReleaseSettlement =
  | { lease: DeviceLease; outcome: ProviderLeaseReleaseOutcome }
  | { lease: DeviceLease; timedOut: true }
  | { lease: DeviceLease; error: unknown };

/**
 * Ends every lease still active at daemon shutdown, whether a session held it or its owner kept it
 * through `close` with `retainOnClose`. Each provider release is bounded by `timeoutMs`; one that
 * runs past it stays with the releaser for the shutdown drain. A release the closed releaser refused is
 * reported per lease and named in the returned summary, so the shutdown says the device was left with
 * the provider instead of reading as a completed release.
 */
export async function finalizeDaemonLeases(params: {
  leaseRegistry: LeaseRegistry;
  expiredProviderLeaseReleaser: ExpiredProviderLeaseReleaser;
  timeoutMs: number;
}): Promise<DaemonLeaseReleaseSummary> {
  const { leaseRegistry, expiredProviderLeaseReleaser, timeoutMs } = params;
  const settlements = await Promise.all(
    leaseRegistry.listActiveLeases().map(async (lease): Promise<LeaseReleaseSettlement> => {
      try {
        const outcome = await releaseWithinTimeout(
          expiredProviderLeaseReleaser.release(lease),
          timeoutMs,
        );
        // The daemon stops either way, so the registry entry goes with it. What carries a lease past this
        // process is its recovery record and its diagnostic, never this registry.
        leaseRegistry.releaseLease(leaseReleaseRequestFor(lease));
        if (outcome === undefined) return { lease, timedOut: true };
        return { lease, outcome };
      } catch (error) {
        return { lease, error };
      }
    }),
  );
  const refused: string[] = [];
  for (const settlement of settlements) {
    const { leaseId } = settlement.lease;
    // A release whose budget ran out is reported here and answered by the drain, which owns the attempt.
    if ('timedOut' in settlement) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_shutdown_lease_release_timed_out',
        data: { leaseId, timeoutMs },
      });
      continue;
    }
    if ('error' in settlement) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_shutdown_lease_release_failed',
        data: {
          leaseId,
          error:
            settlement.error instanceof Error ? settlement.error.message : String(settlement.error),
        },
      });
      continue;
    }
    // The mapping owns the event, so a refusal reads the same here as it does on the expiry route.
    const event = leaseReleaseDiagnosticEvent(settlement.lease, settlement.outcome);
    if (event) emitDiagnostic(event);
    if (settlement.outcome.status === 'refused') refused.push(leaseId);
  }
  return Object.freeze({ refused: Object.freeze(refused) });
}

async function releaseWithinTimeout<T>(
  release: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs);
    void release.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
