import type { SimlockLeaseClient } from '../simlock-allocator.ts';

type SimlockGrant = Awaited<ReturnType<SimlockLeaseClient['requestLease']>>;
type SimlockLease = Readonly<{ id: string; requesterId: string; ttlDeadline: number }>;
type Waiter = {
  key: string;
  provisioning: boolean;
  resolve(grant: SimlockGrant): void;
  reject(error: Error): void;
};

export function simlockError(code: string): Error {
  return Object.assign(new Error(`simlock ${code}`), { code });
}

/**
 * One principal's view of an in-memory Simlock daemon, reached through connections that die like
 * a process's socket. It models only the behavior the adapter relies on, as read from Simlock's
 * contract: one lease per requester, replay of a settled request under its idempotency key,
 * cancel by requester (`not-cancellable` once device work claimed the request), principal-scoped
 * listing, and deletion on release or expiry. A request outlives the connection that sent it.
 */
export function createFakeSimlock(options: { ttlMs: number; grantOnRequest?: boolean }) {
  let devices = 0;
  const waiters = new Map<string, Waiter>();
  const settled = new Map<string, SimlockGrant | Error>();
  const leases = new Map<string, SimlockLease>();

  const settle = (requesterId: string, outcome: SimlockGrant | Error) => {
    const waiter = waiters.get(requesterId);
    if (!waiter) throw new Error(`no request is waiting for ${requesterId}`);
    waiters.delete(requesterId);
    settled.set(waiter.key, outcome);
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
  };

  const grant = (requesterId: string) => {
    devices += 1;
    const lease = {
      id: `lease-${devices}`,
      requesterId,
      ttlDeadline: Date.now() + options.ttlMs,
    };
    leases.set(lease.id, lease);
    settle(requesterId, {
      device: { id: `device-${devices}`, driverDeviceId: `UDID-${devices}` },
      environment: { SIMLOCK_IOS_DEVICE_SET: '/simlock/devices' },
      lease: { id: lease.id, ttlDeadline: lease.ttlDeadline },
    });
  };

  const requestLease: SimlockLeaseClient['requestLease'] = (input) => {
    const key = JSON.stringify([input.requesterId, input.idempotencyKey]);
    const replay = settled.get(key);
    if (replay) return replay instanceof Error ? Promise.reject(replay) : Promise.resolve(replay);
    if ([...leases.values()].some((lease) => lease.requesterId === input.requesterId)) {
      return Promise.reject(simlockError('REQUESTER_ALREADY_LEASED'));
    }
    const response = new Promise<SimlockGrant>((resolve, reject) => {
      waiters.set(input.requesterId, { key, provisioning: false, resolve, reject });
    });
    if (options.grantOnRequest ?? true) grant(input.requesterId);
    return response;
  };

  const daemon: SimlockLeaseClient = {
    requestLease,
    cancelLease: async ({ requesterId }) => {
      const waiter = waiters.get(requesterId);
      if (!waiter) return { result: 'not-found' };
      if (waiter.provisioning) return { result: 'not-cancellable' };
      settle(requesterId, simlockError('CANCELLED'));
      return { result: 'cancelled' };
    },
    renewLease: async ({ leaseId, ttlMs }) => {
      const lease = leases.get(leaseId);
      if (!lease) throw simlockError('UNKNOWN_LEASE');
      const renewed = { ...lease, ttlDeadline: Date.now() + ttlMs };
      leases.set(leaseId, renewed);
      return { id: leaseId, ttlDeadline: renewed.ttlDeadline };
    },
    releaseLease: async ({ leaseId }) => {
      if (!leases.delete(leaseId)) throw simlockError('UNKNOWN_LEASE');
      return { leaseId };
    },
    listLeases: async () => ({ leases: [...leases.values()] }),
  };

  return {
    leases: () => [...leases.values()],
    waiting: () => [...waiters.keys()],
    /** Finishes provisioning for the requester's waiting request. */
    grant,
    /** Device work claims the waiting request, so cancelling it no longer rejects it. */
    startProvisioning: (requesterId: string) => {
      const waiter = waiters.get(requesterId);
      if (!waiter) throw new Error(`no request is waiting for ${requesterId}`);
      waiter.provisioning = true;
    },
    /** TTL expiry: Simlock reclaims the lease and deletes its device. */
    expire: (leaseId: string) => leases.delete(leaseId),
    connect() {
      let closed = false;
      let loseNextResponse = false;
      const call =
        <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>) =>
        async (...args: Args): Promise<Result> => {
          if (closed) throw simlockError('DAEMON_CONNECTION_LOST');
          const response = method(...args);
          if (loseNextResponse) {
            loseNextResponse = false;
            response.catch(() => {});
            throw simlockError('DAEMON_CONNECTION_LOST');
          }
          // A dead process never hears the answer to a call it had in flight.
          const answer = await response.then(
            (value) => () => value,
            (error: unknown) => () => {
              throw error;
            },
          );
          if (closed) return await new Promise<never>(() => {});
          return answer();
        };
      const client: SimlockLeaseClient = {
        requestLease: call(daemon.requestLease),
        cancelLease: call(daemon.cancelLease),
        renewLease: call(daemon.renewLease),
        releaseLease: call(daemon.releaseLease),
        listLeases: call(daemon.listLeases),
      };
      return {
        client,
        /** The next call reaches the daemon, but its answer never comes back. */
        loseNextResponse: () => {
          loseNextResponse = true;
        },
        /** The process holding this connection died. */
        close: () => {
          closed = true;
        },
      };
    },
  };
}
