import type { DurableDescriptorCodec } from './durable-resource-envelope.ts';
import type { PlatformRequestScope } from './platform-runtime-host.ts';
import type { ResourceOwnershipFence } from './platform-runtime.ts';

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

/** Facets specialize this with their own descriptor, live handle, and result types. */
export type DurableResourceFacet<
  Descriptor extends object,
  Handle extends AsyncDisposable,
  Result,
  ResourceKind extends string,
> = Readonly<{
  codec: DurableDescriptorCodec<Descriptor, ResourceKind>;
  reattach(
    descriptor: Descriptor,
    fence: ResourceOwnershipFence,
    scope: PlatformRequestScope,
  ): Promise<ReattachOutcome<Handle, Result>>;
  cleanup(
    descriptor: Descriptor,
    fence: ResourceOwnershipFence,
    scope: PlatformRequestScope,
  ): Promise<CleanupOutcome>;
}>;

export function isConfirmedCleanup(
  outcome: CleanupOutcome,
): outcome is Extract<CleanupOutcome, { status: 'cleaned' | 'already-missing' }> {
  return outcome.status === 'cleaned' || outcome.status === 'already-missing';
}
