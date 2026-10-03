import type { JsonObject } from './json.ts';

export type CleanupPendingReason =
  | 'ownership-fence-lost'
  | 'owner-unavailable'
  | 'transport-failed'
  | 'cleanup-unconfirmed'
  | 'manual-recovery-required';

export type CleanupOutcome =
  | Readonly<{ status: 'cleaned' }>
  | Readonly<{ status: 'already-missing' }>
  | Readonly<{
      status: 'cleanup-pending';
      reason: CleanupPendingReason;
      message?: string;
    }>;

export type FinishOutcome<Result> =
  | Readonly<{ status: 'completed'; result: Result; alreadyCompleted?: boolean }>
  | Readonly<{
      status: 'cleanup-pending';
      reason: CleanupPendingReason;
      message?: string;
    }>;

/**
 * The durable half of a stop that has not committed yet. A resource kind with mid-stop facts to keep
 * (screen recording, ADR 0024 2.3) hands its handle this so the stop can persist what just became
 * durable — a collected copy, a finished export — into its own manifest while the fence it already
 * holds is held. `learned` is the manifest's metadata as an earlier attempt left it, which is what
 * lets a retry resume instead of repeating work that would change the artifact. The facts are the
 * manifest's own JSON: the mechanics merge them and never interpret them.
 */
export type DurableCaptureProgress = Readonly<{
  record(fact: JsonObject): void;
  readonly learned: JsonObject | undefined;
}>;

/** Common lifecycle shape implemented by a facet-specific live handle contract. */
export type LiveResourceHandle<Result> = AsyncDisposable &
  Readonly<{
    finish(progress?: DurableCaptureProgress): Promise<FinishOutcome<Result>>;
    forceCleanup(): Promise<CleanupOutcome>;
  }>;

export type ResourceUnreattachableReason =
  | 'descriptor-invalid'
  | 'descriptor-version-unsupported'
  | 'owner-unavailable'
  | 'transport-not-reattachable'
  | 'ownership-fence-lost';

export type ReattachOutcome<Handle extends AsyncDisposable, Result> =
  | Readonly<{ status: 'active'; handle: Handle }>
  | Readonly<{ status: 'completed'; result: Result }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{
      status: 'unreattachable';
      reason: ResourceUnreattachableReason;
      message?: string;
    }>;

export function isConfirmedCleanup(
  outcome: CleanupOutcome,
): outcome is Extract<CleanupOutcome, { status: 'cleaned' | 'already-missing' }> {
  return outcome.status === 'cleaned' || outcome.status === 'already-missing';
}
