import { AppError } from '@agent-device/kernel/errors';
import { LEASE_REASONS } from '@agent-device/contracts/lease-scope';
import {
  getRequestDeadlineMs,
  isRequestCanceled,
  throwIfRequestCanceled,
} from '@agent-device/host-kit/request';
import { isHumanControlMutation } from '../core/daemon-command-registry.ts';
import { recordEndedLease } from '../core/request-ended-leases.ts';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import { deviceLeaseBusyError } from '../resources/lease-registry-scope.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { NeedSettlement } from './lease-session-end.ts';

export function inactiveLease(): AppError {
  return new AppError('UNAUTHORIZED', 'Lease is not active', {
    reason: LEASE_REASONS.notFound.reason,
    dispatched: 'no',
  });
}

export async function waitForLeaseSettlement(params: {
  attempt: NeedSettlement;
  req: DaemonRequest;
  leaseRegistry: LeaseRegistry;
  signal: AbortSignal | undefined;
  waitDeadline: number;
}): Promise<() => boolean> {
  const { attempt, req, leaseRegistry, signal, waitDeadline } = params;
  const { awaitExpiry } = await import('./lease-session-end.ts');
  const deadline = getRequestDeadlineMs(req.meta?.requestId) ?? Infinity;
  const settled = await awaitExpiry(
    attempt.settlement.done,
    signal,
    Math.min(waitDeadline, deadline),
  );
  throwIfRequestCanceled(req.meta?.requestId);
  if (attempt.ownerLeaseId) {
    if (settled && req.command === 'close' && attempt.settlement.takeReceipt())
      recordEndedLease(req, attempt.ownerLeaseId);
    throw inactiveLease();
  }
  if (!attempt.successorIsCurrent?.()) throw inactiveLease();
  if (!settled) throw leaseRegistry.leaseEndRefusal(attempt.leaseId) ?? deviceLeaseBusyError();
  return attempt.successorIsCurrent;
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
  if (req.command === 'close' && leaseRegistry.canRetryClose(lease.leaseId))
    return await leaseRegistry.runDeviceMutation(lease, task, 'close-retry');
  const work = leaseRegistry.retainLeaseWork(lease, () => !isRequestCanceled(req.meta?.requestId));
  try {
    return await (isHumanControlMutation(req)
      ? leaseRegistry.runDeviceMutation(lease, task)
      : task());
  } finally {
    work.release();
  }
}
