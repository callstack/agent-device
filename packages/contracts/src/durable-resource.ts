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

/** Common lifecycle shape implemented by a facet-specific live handle contract. */
export type LiveResourceHandle<Result> = AsyncDisposable &
  Readonly<{
    finish(): Promise<FinishOutcome<Result>>;
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
