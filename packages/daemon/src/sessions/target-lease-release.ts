import type { LeaseLifecycleProvider } from '@agent-device/contracts/device';
import { leaseScopeToReleaseRequest } from '@agent-device/contracts/lease-scope';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionState } from '../core/session-state.ts';
import {
  isBoundedCompositeRequest,
  refuseBoundedCompositeResourceOperation,
  resolveRequestOrSessionLeaseScope,
} from '../core/lease-context.ts';
import { recordEndedLease } from '../core/request-ended-leases.ts';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import { releaseLease } from '../resources/lease-release.ts';

/** A runtime can end only the lease admitted for this request and owned by that runtime's provider. */
export async function releaseTargetLease(params: {
  req: DaemonRequest;
  session?: SessionState;
  owner: RuntimeOwnerRef;
  leaseId: string;
  leaseRegistry?: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
}): Promise<Record<string, unknown> | undefined> {
  if (isBoundedCompositeRequest(params.req)) {
    refuseBoundedCompositeResourceOperation(params.req, 'provider-lease');
  }
  const scope = resolveRequestOrSessionLeaseScope(params.req, params.session);
  if (
    params.owner.kind !== 'provider-runtime' ||
    scope.leaseId !== params.leaseId ||
    scope.leaseProvider !== params.owner.provider ||
    !params.leaseRegistry ||
    !params.leaseLifecycleProvider?.release
  ) {
    throw new AppError('UNAUTHORIZED', 'The selected target does not own this request lease.', {
      reason: 'TARGET_SHUTDOWN_LEASE_MISMATCH',
    });
  }
  const request = leaseScopeToReleaseRequest(scope);
  const lease = params.leaseRegistry.getLease(request);
  if (!lease) {
    throw new AppError('UNAUTHORIZED', 'The target lease is no longer active.', {
      reason: 'LEASE_NOT_FOUND',
      leaseId: params.leaseId,
    });
  }
  const outcome = await releaseLease(
    params.leaseRegistry,
    params.leaseLifecycleProvider,
    lease,
    request,
  );
  recordEndedLease(params.req, lease.leaseId);
  return outcome.provider;
}
