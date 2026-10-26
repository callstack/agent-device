import { addAbortListener } from 'node:events';
import type {
  LeaseRefusalReason,
  LeaseRequestInput,
  LeaseRequestRef,
  LeaseRequestStatus,
  ManagedDeviceAllocatorPort,
  ManagedLease,
} from '@agent-device/contracts/managed-device-allocation';
import { allocationOperationKey } from '@agent-device/managed-allocation/fence';
import { AppError } from '@agent-device/kernel/errors';

type SimlockLeaseRecord = Readonly<{ id: string; ttlDeadline: number }>;
type SimlockLeaseGrant = Readonly<{
  device: Readonly<{ id: string; driverDeviceId: string }>;
  environment: Readonly<Record<string, string>>;
  lease: SimlockLeaseRecord;
}>;

/**
 * The part of `simlock/client`'s `SimlockClient` this adapter drives, declared structurally so
 * the daemon composes a real client without agent-device depending on the simlock package.
 */
export type SimlockLeaseClient = Readonly<{
  requestLease(
    input: Readonly<{
      platform: 'ios' | 'android';
      model: string;
      osVersion?: string;
      requesterId: string;
      idempotencyKey: string;
      noWait: boolean;
      timeoutMs: number;
    }>,
  ): Promise<SimlockLeaseGrant>;
  cancelLease(
    input: Readonly<{ requesterId: string }>,
  ): Promise<Readonly<{ result: 'cancelled' | 'not-found' | 'not-cancellable' }>>;
  renewLease(input: Readonly<{ leaseId: string; ttlMs: number }>): Promise<SimlockLeaseRecord>;
  releaseLease(input: Readonly<{ leaseId: string }>): Promise<unknown>;
  listLeases(): Promise<
    Readonly<{ leases: readonly (SimlockLeaseRecord & Readonly<{ requesterId: string }>)[] }>
  >;
}>;

type Attempt = {
  status: LeaseRequestStatus;
  error?: unknown;
  settled: Promise<void>;
};

const REFUSALS: Readonly<Record<string, LeaseRefusalReason>> = {
  NO_CAPACITY: 'simulator-capacity',
  QUEUE_TIMEOUT: 'simulator-capacity',
  INSUFFICIENT_DISK_SPACE: 'disk-low',
  UNKNOWN_MODEL: 'invalid-shape',
  NO_DRIVER: 'invalid-shape',
  RUNTIME_MISSING: 'preparation-required',
  LICENSE_NOT_ACCEPTED: 'preparation-required',
  DOWNLOADS_DISABLED: 'preparation-required',
  DOWNLOAD_TIMEOUT: 'preparation-required',
  REQUESTER_ALREADY_LEASED: 'requester-busy',
};

/**
 * `ManagedDeviceAllocatorPort` over Simlock's agent-role client (ADR 0021 §4). Simlock has no
 * read-only request lookup: replaying `lease.request` under an idempotency key whose settled
 * record has aged out creates a new device. So attempts are answered from this process's own
 * record of them, and live lease authority from `lease.list`; an attempt this process did not
 * start is unknown, which keeps its journal entry non-executable until Simlock expires the lease.
 * Such an attempt, or one whose request response was lost, can still be cancelled: Simlock
 * cancels by requester and holds at most one lease per requester, so once nothing is pending the
 * requester's listed lease is this attempt's grant and is released.
 *
 * Simlock scopes requesters to the session principal only, so the requester it sees is prefixed
 * with this allocator's instance id: two daemons sharing a principal never cancel or match each
 * other's requests.
 */
export function createSimlockManagedDeviceAllocator(options: {
  instanceId: string;
  client: SimlockLeaseClient;
}): ManagedDeviceAllocatorPort {
  const { client } = options;
  const simlockRequester = (requesterId: string) => `${options.instanceId}:${requesterId}`;
  const attempts = new Map<string, Attempt>();
  const leases = new Map<string, ManagedLease>();

  const attemptFor = (ref: LeaseRequestRef): Attempt => {
    const attempt = attempts.get(allocationOperationKey(ref));
    if (!attempt) {
      throw new AppError('COMMAND_FAILED', 'Simlock attempt is not known to this daemon.', {
        reason: 'simlock-attempt-unknown',
        requesterId: ref.requesterId,
        attemptKey: ref.attemptKey,
      });
    }
    return attempt;
  };

  const start = (input: LeaseRequestInput): Attempt => {
    const base = {
      requesterId: input.requesterId,
      requestGeneration: input.requestGeneration,
      attemptKey: input.attemptKey,
    };
    const attempt: Attempt = {
      status: { ...base, state: 'pending' },
      settled: Promise.resolve(),
    };
    attempt.settled = client
      .requestLease({
        platform: input.shape.platform,
        model: input.shape.deviceType,
        ...(input.shape.osVersion === undefined ? {} : { osVersion: input.shape.osVersion }),
        requesterId: simlockRequester(input.requesterId),
        idempotencyKey: input.attemptKey,
        noWait: true,
        timeoutMs: Math.max(1, input.deadlineAtMs - Date.now()),
      })
      .then(
        (grant) => {
          const lease: ManagedLease = {
            id: grant.lease.id,
            ttlDeadline: grant.lease.ttlDeadline,
            device: { address: grant.device.driverDeviceId },
            environment: { ...grant.environment },
          };
          leases.set(lease.id, lease);
          attempt.status = {
            ...base,
            state: 'granted',
            identityIncarnationId: grant.device.id,
            lease,
          };
        },
        (error: unknown) => {
          const code = simlockErrorCode(error);
          const reason = code === undefined ? undefined : REFUSALS[code];
          if (reason) {
            attempt.status = {
              ...base,
              state: 'refused',
              refusal: { reason, ...(error instanceof Error ? { message: error.message } : {}) },
            };
          } else if (code === 'CANCELLED') {
            attempt.status = { ...base, state: 'cancelled' };
          } else {
            attempt.status = { ...base, state: 'unknown' };
            attempt.error = error;
          }
        },
      )
      // A grant this adapter cannot map leaves the attempt unknown, so `settled` never rejects.
      .catch((error: unknown) => {
        attempt.status = { ...base, state: 'unknown' };
        attempt.error = error;
      });
    attempts.set(allocationOperationKey(input), attempt);
    return attempt;
  };

  const liveStatus = async (attempt: Attempt): Promise<LeaseRequestStatus> => {
    const { status } = attempt;
    if (status.state !== 'granted' || !status.lease) return status;
    const leaseId = status.lease.id;
    const live = (await client.listLeases()).leases.find((lease) => lease.id === leaseId);
    if (!live) {
      const { requesterId, requestGeneration, attemptKey } = status;
      return { requesterId, requestGeneration, attemptKey, state: 'unknown' };
    }
    const lease = { ...status.lease, ttlDeadline: live.ttlDeadline };
    leases.set(lease.id, lease);
    return { ...status, lease };
  };

  const cancelByRequester = async (ref: LeaseRequestRef): Promise<LeaseRequestStatus> => {
    const { requesterId, requestGeneration, attemptKey } = ref;
    const requester = simlockRequester(requesterId);
    const { result } = await client.cancelLease({ requesterId: requester });
    // Device work in flight has no outcome yet; a later cancel finds it pending or listed.
    if (result === 'not-cancellable') {
      return { requesterId, requestGeneration, attemptKey, state: 'unknown' };
    }
    if (result === 'not-found') {
      const listed = (await client.listLeases()).leases.find(
        (lease) => lease.requesterId === requester,
      );
      if (listed) await releaseLease({ leaseId: listed.id });
    }
    return { requesterId, requestGeneration, attemptKey, state: 'cancelled' };
  };

  const releaseLease = async ({ leaseId }: Readonly<{ leaseId: string }>): Promise<void> => {
    try {
      await client.releaseLease({ leaseId });
    } catch (error) {
      // An ended lease is already back with Simlock, which deletes its device.
      if (simlockErrorCode(error) !== 'UNKNOWN_LEASE') throw error;
    }
    leases.delete(leaseId);
    for (const [key, attempt] of attempts) {
      if (attempt.status.lease?.id === leaseId) attempts.delete(key);
    }
  };

  /** An attempt that ended without a device has nothing left to look up or cancel. */
  const settle = (ref: LeaseRequestRef, status: LeaseRequestStatus): LeaseRequestStatus => {
    if (status.state === 'refused' || status.state === 'cancelled')
      attempts.delete(allocationOperationKey(ref));
    return status;
  };

  return Object.freeze({
    instanceId: options.instanceId,
    requestLease: async (input) => {
      const attempt = attempts.get(allocationOperationKey(input)) ?? start(input);
      if (!(await settledBefore(attempt.settled, input.signal))) return attempt.status;
      if (attempt.error !== undefined) throw attempt.error;
      return settle(input, attempt.status);
    },
    getLeaseRequestStatus: async (ref) => await liveStatus(attemptFor(ref)),
    cancelLeaseRequest: async (ref) => {
      const attempt = attempts.get(allocationOperationKey(ref));
      if (!attempt || attempt.status.state === 'unknown') {
        return settle(ref, await cancelByRequester(ref));
      }
      if (attempt.status.state === 'pending') {
        await client.cancelLease({ requesterId: simlockRequester(ref.requesterId) });
        // An uncancellable request is still provisioning; its grant is the caller's to release.
        await attempt.settled;
      }
      return settle(ref, await liveStatus(attempt));
    },
    renewLease: async ({ leaseId, ttlDeadline }) => {
      const known = leases.get(leaseId);
      if (!known) {
        throw new AppError('COMMAND_FAILED', 'Simlock lease is not known to this daemon.', {
          reason: 'simlock-lease-unknown',
          leaseId,
        });
      }
      const ttlMs = ttlDeadline - Date.now();
      if (!(ttlMs > 0)) {
        throw new AppError('INVALID_ARGS', 'Simlock renewal requires a future deadline.');
      }
      const renewed = await client.renewLease({ leaseId, ttlMs });
      const lease = { ...known, ttlDeadline: renewed.ttlDeadline };
      leases.set(leaseId, lease);
      return lease;
    },
    releaseLease,
  });
}

function simlockErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Resolves `true` once `work` settles, or `false` if `signal` aborts first. */
function settledBefore(work: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) return work.then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const listener = addAbortListener(signal, () => resolve(false));
    void work.then(() => {
      listener[Symbol.dispose]();
      resolve(true);
    });
  });
}
