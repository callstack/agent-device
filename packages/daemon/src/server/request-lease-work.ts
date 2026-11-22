import { isRequestCanceled, throwIfRequestCanceled } from '@agent-device/host-kit/request';
import { isHumanControlMutation } from '../core/daemon-command-registry.ts';
import type { LeaseRegistry, RetainedLeaseWork } from '../resources/lease-registry.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { DeviceLease } from '@agent-device/contracts/device';

function retainRequestLeaseWork(
  leaseRegistry: LeaseRegistry,
  lease: Pick<DeviceLease, 'leaseId'>,
  requestId: string | undefined,
): RetainedLeaseWork {
  return leaseRegistry.retainLeaseWork(lease, () => !isRequestCanceled(requestId));
}

export function retainSuccessorLeaseWork(
  leaseRegistry: LeaseRegistry,
  req: DaemonRequest,
  lease: DeviceLease,
): { req: DaemonRequest; work: RetainedLeaseWork } {
  return {
    req: { ...req, internal: { ...req.internal, admittedLease: lease } },
    work: retainRequestLeaseWork(leaseRegistry, lease, req.meta?.requestId),
  };
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
    /** A work pass already held and released by the caller. */
    retainedWork?: RetainedLeaseWork;
    task: () => Promise<T>;
  }>,
): Promise<T> {
  const { leaseRegistry, req, retainedWork, task } = params;
  const lease = req.internal?.admittedLease;
  if (!lease) return await task();
  if (retainedWork) {
    throwIfRequestCanceled(req.meta?.requestId);
    retainedWork.assertRetained();
  }
  const work = retainedWork ?? retainRequestLeaseWork(leaseRegistry, lease, req.meta?.requestId);
  try {
    return await (isHumanControlMutation(req)
      ? leaseRegistry.runDeviceMutation(lease, task)
      : task());
  } finally {
    if (!retainedWork) work.release();
  }
}
