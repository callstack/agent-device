import type { DURABLE_RESOURCE_REASONS } from '@agent-device/kernel/errors';
import type { JsonObject } from './json.ts';

type DurableResourceReason<K extends keyof typeof DURABLE_RESOURCE_REASONS> =
  (typeof DURABLE_RESOURCE_REASONS)[K]['reason'];

export type CleanupPendingReason = DurableResourceReason<
  | 'ownershipFenceLost'
  | 'ownerUnavailable'
  | 'transportFailed'
  | 'cleanupUnconfirmed'
  | 'manualRecoveryRequired'
>;

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

export type ResourceUnreattachableReason = DurableResourceReason<
  | 'descriptorInvalid'
  | 'descriptorVersionUnsupported'
  | 'ownerUnavailable'
  | 'transportNotReattachable'
  | 'ownershipFenceLost'
>;

/** The reasons a stored descriptor that does not decode is unreattachable for. */
export type DescriptorDecodeFailureReason = DurableResourceReason<
  'descriptorInvalid' | 'descriptorVersionUnsupported'
>;

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

/** Shares in-flight cleanup and retains only confirmed release across cleanup and disposal. */
export function createRetryableCleanup(
  clean: () => Promise<CleanupOutcome>,
  assertConfirmed: (outcome: CleanupOutcome, cause?: unknown) => void,
) {
  let cleanup: Promise<CleanupOutcome> | undefined;
  const forceCleanup = (): Promise<CleanupOutcome> =>
    (cleanup ??= clean().then(
      (outcome) => {
        if (!isConfirmedCleanup(outcome)) cleanup = undefined;
        return outcome;
      },
      (error) => {
        cleanup = undefined;
        throw error;
      },
    ));
  return {
    forceCleanup,
    [Symbol.asyncDispose]: async () => {
      // A rejected cleanup confirms nothing, so disposal reports it as cleanup-pending.
      const { outcome, cause } = await forceCleanup().then(
        (confirmed) => ({ outcome: confirmed, cause: undefined }),
        (error: unknown) => ({
          outcome: {
            status: 'cleanup-pending',
            // Type-checked against the kernel row: a value import would make this subpath load
            // kernel errors.
            reason: 'cleanup-unconfirmed' satisfies DurableResourceReason<'cleanupUnconfirmed'>,
            // Non-Error rejections keep the facet's default message; `cause` keeps the raw value.
            message: error instanceof Error ? error.message : undefined,
          } as const,
          cause: error,
        }),
      );
      assertConfirmed(outcome, cause);
    },
  };
}
