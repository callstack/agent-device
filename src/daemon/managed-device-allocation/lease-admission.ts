import { addAbortListener } from 'node:events';
import type {
  LeaseRequestStatus,
  ManagedDeviceAllocatorPort,
  ManagedLease,
} from '@agent-device/contracts/managed-device-allocation';
import {
  managedBindingFence,
  managedLocalRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import type { Deadline } from '@agent-device/host-kit/retry';
import type { ManagedLeaseReachability } from '../../managed-device-reachability.ts';
import {
  freezeLease,
  isRequestGeneration,
  isValidLease,
  isVerbatimId,
} from './record-validation.ts';

export type ManagedCommandHorizon = Readonly<{ deadline: Deadline; teardownTimeoutMs: number }>;
type FenceReason = 'released' | 'replaced' | 'superseded' | 'fenced' | 'authority-unconfirmed';
export type ManagedLeaseAdmissionFailure =
  | Readonly<{ status: 'abandoned' | 'deadline-exceeded' }>
  | Readonly<{ status: 'teardown-required'; reason: FenceReason; error?: NormalizedError }>;
export type ManagedLeaseAdmissionResult<T> =
  | Readonly<{ status: 'admitted'; ttlDeadline: number; value: T }>
  | ManagedLeaseAdmissionFailure;

export type ManagedLeaseAdmission = Readonly<{
  owner: ReturnType<typeof managedLocalRuntimeOwner>;
  fence: ReturnType<typeof managedBindingFence>;
  reachability: ManagedLeaseReachability;
  run<T>(
    horizon: ManagedCommandHorizon,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<ManagedLeaseAdmissionResult<T>>;
  fenceBinding(reason: FenceReason, error?: NormalizedError): void;
}>;

/** One binding incarnation; its coordinator fences it before release, replacement or supersession. */
export function createManagedLeaseAdmission(params: {
  allocator: ManagedDeviceAllocatorPort;
  grant: LeaseRequestStatus;
  reachability: ManagedLeaseReachability;
  renewalSafetyWindowMs: number;
}): ManagedLeaseAdmission {
  const { allocator, renewalSafetyWindowMs, reachability } = params;
  const grant = { ...params.grant };
  if (
    grant.state !== 'granted' ||
    !grant.lease ||
    !isValidLease(grant.lease) ||
    grant.refusal ||
    !isVerbatimId(grant.requesterId) ||
    !isRequestGeneration(grant.requestGeneration) ||
    !isVerbatimId(grant.attemptKey) ||
    !isVerbatimId(grant.identityIncarnationId) ||
    !Number.isFinite(renewalSafetyWindowMs) ||
    renewalSafetyWindowMs < 0 ||
    !sameLeaseIdentity(grant.lease, reachability.lease)
  )
    throw new AppError(
      'INVALID_ARGS',
      'Managed admission requires a confirmed grant and its transport.',
    );
  const fence = managedBindingFence({
    ...grant,
    identityIncarnationId: grant.identityIncarnationId,
  });
  const owner = managedLocalRuntimeOwner(allocator.instanceId);
  let confirmed = freezeLease(grant.lease);
  let stopped: Extract<ManagedLeaseAdmissionFailure, { status: 'teardown-required' }> | undefined;
  let pending: Promise<void> | undefined;
  const fenced = new AbortController();

  const stop = (reason: FenceReason, error?: NormalizedError) => {
    stopped ??= Object.freeze({ status: 'teardown-required', reason, ...(error && { error }) });
    fenced.abort();
  };
  const confirms = (lease: ManagedLease | undefined, minimum: number): lease is ManagedLease =>
    lease !== undefined &&
    isValidLease(lease) &&
    sameLeaseIdentity(confirmed, lease) &&
    lease.ttlDeadline >= minimum &&
    lease.ttlDeadline > Date.now();

  const renew = async (minimum: number): Promise<void> => {
    try {
      const lease = await allocator.renewLease({
        leaseId: confirmed.id,
        ttlDeadline: Math.max(confirmed.ttlDeadline, minimum + renewalSafetyWindowMs),
      });
      if (stopped) return;
      if (!confirms(lease, minimum)) {
        throw new AppError(
          'COMMAND_FAILED',
          'Allocator renewal did not confirm the binding horizon.',
          {
            reason: 'managed-lease-renewal-invalid',
          },
        );
      }
      confirmed = freezeLease(lease);
    } catch (error) {
      if (stopped) return;
      try {
        const status = await allocator.getLeaseRequestStatus({
          requesterId: grant.requesterId,
          attemptKey: grant.attemptKey,
        });
        if (stopped) return;
        if (confirmsGrantedAttempt(status, grant) && confirms(status.lease, minimum)) {
          confirmed = freezeLease(status.lease);
          return;
        }
      } catch (lookupError) {
        stop('authority-unconfirmed', normalizeError(lookupError));
        return;
      }
      stop('authority-unconfirmed', normalizeError(error));
    }
  };

  const hasConfirmedHorizon = (required: number, checkedAllocator: boolean): boolean =>
    !pending &&
    confirmed.ttlDeadline >= required &&
    (checkedAllocator || confirmed.ttlDeadline > Date.now() + renewalSafetyWindowMs);

  const run = async <T>(
    horizon: ManagedCommandHorizon,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<ManagedLeaseAdmissionResult<T>> => {
    const required = minimumLeaseHorizon(horizon);
    let checkedAllocator = false;
    while (true) {
      if (stopped) return stopped;
      if (signal.aborted) return { status: 'abandoned' };
      if (horizon.deadline.isExpired()) return { status: 'deadline-exceeded' };
      if (hasConfirmedHorizon(required, checkedAllocator)) {
        const ttlDeadline = confirmed.ttlDeadline;
        return { status: 'admitted', ttlDeadline, value: await task() };
      }
      if (!pending) {
        pending = renew(Math.max(required, confirmed.ttlDeadline)).finally(() => {
          pending = undefined;
        });
      }
      const abandoned = await waitForRenewal(
        pending,
        horizon.deadline,
        AbortSignal.any([signal, fenced.signal]),
      );
      if (stopped) return stopped;
      if (abandoned) return abandoned;
      checkedAllocator = true;
    }
  };
  return Object.freeze({ owner, fence, reachability, run, fenceBinding: stop });
}

function minimumLeaseHorizon(horizon: ManagedCommandHorizon): number {
  if (!Number.isFinite(horizon.teardownTimeoutMs) || horizon.teardownTimeoutMs <= 0) {
    throw new AppError(
      'INVALID_ARGS',
      'Managed admission requires a finite canonical teardown budget.',
    );
  }
  const now = Date.now();
  const required = now + horizon.deadline.remainingMs(now) + horizon.teardownTimeoutMs;
  if (!Number.isFinite(required))
    throw new AppError('INVALID_ARGS', 'Managed commands require a finite deadline.');
  return required;
}

function confirmsGrantedAttempt(status: LeaseRequestStatus, grant: LeaseRequestStatus): boolean {
  return (
    status.state === 'granted' &&
    status.refusal === undefined &&
    status.requesterId === grant.requesterId &&
    status.attemptKey === grant.attemptKey &&
    status.requestGeneration === grant.requestGeneration &&
    status.identityIncarnationId === grant.identityIncarnationId
  );
}

function sameLeaseIdentity(left: ManagedLease, right: ManagedLease): boolean {
  return (
    left.id === right.id &&
    left.device.address === right.device.address &&
    Object.keys(left.environment).length === Object.keys(right.environment).length &&
    Object.entries(left.environment).every(([key, value]) => right.environment[key] === value)
  );
}

function waitForRenewal(
  work: Promise<void>,
  deadline: Deadline,
  signal: AbortSignal,
): Promise<ManagedLeaseAdmissionFailure | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ status: 'deadline-exceeded' }), deadline.remainingMs());
    const listener = addAbortListener(signal, () => finish({ status: 'abandoned' }));
    function finish(result?: ManagedLeaseAdmissionFailure) {
      clearTimeout(timer);
      listener[Symbol.dispose]();
      resolve(result);
    }
    void work.then(() => finish());
  });
}
