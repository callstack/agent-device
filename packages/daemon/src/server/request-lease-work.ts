import { AppError } from '@agent-device/kernel/errors';
import { LEASE_REASONS } from '@agent-device/contracts/lease-scope';
import { isRequestCanceled } from '@agent-device/host-kit/request';
import { isHumanControlMutation } from '../core/daemon-command-registry.ts';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';

export function inactiveLease(): AppError {
  return new AppError('UNAUTHORIZED', 'Lease is not active', {
    reason: LEASE_REASONS.notFound.reason,
    dispatched: 'no',
  });
}

/**
 * Runs one admitted request's work under the protection of its lease.
 *
 * A lease renews when a request is admitted and never again while that request
 * works, so the slowest command in a session used to expire the very lease that
 * was paying for the device and tear the session down underneath the client still
 * waiting for its result. The pass defers expiry only while the work is
 * still wanted, which the request-cancel registry already knows: once the client
 * hangs up the request protects nothing, so a handler that ignores its
 * cancellation cannot hold a rented device open.
 */
export async function runAdmittedLeaseWork<T>(
  params: Readonly<{
    leaseRegistry: LeaseRegistry;
    req: DaemonRequest;
    task: () => Promise<T>;
    assertCurrent?: () => void;
  }>,
): Promise<T> {
  const { leaseRegistry, req, task } = params;
  const lease = req.internal?.admittedLease;
  if (!lease) return await task();
  params.assertCurrent?.();
  const work = leaseRegistry.retainLeaseWork(lease, () => !isRequestCanceled(req.meta?.requestId));
  try {
    return await (isHumanControlMutation(req)
      ? leaseRegistry.runDeviceMutation(lease, task)
      : task());
  } finally {
    work.release();
  }
}
