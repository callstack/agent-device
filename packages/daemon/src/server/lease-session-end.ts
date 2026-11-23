import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
import { AsyncResource } from 'node:async_hooks';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { type AppError, errorMessage } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { SessionStore } from '../core/session-store.ts';
import type { SessionRef } from '../core/session-state.ts';
import type { PlatformResourceCleanup } from '../core/platform-resource-cleanup.ts';
import {
  endLeasedSession,
  type LeaseEndReason,
  type SessionTeardown,
} from '../sessions/lease-lifecycle.ts';
import { existingSessionExecutionLockKeys } from './request-binding.ts';
import { withRequestExecutionLockKeys } from './request-execution-locks.ts';

export type ExpirySettlement = {
  done: Promise<boolean>;
  takeReceipt(): boolean;
};

export type Admission =
  | { kind: 'admitted' }
  | { kind: 'replan' }
  | {
      kind: 'need-settlement';
      settlement: ExpirySettlement;
      ownerLeaseId?: string;
      successorIsCurrent?: () => boolean;
    }
  | { kind: 'refused'; error: AppError };

export type LockedAttempt<T> =
  | Exclude<Admission, { kind: 'admitted' }>
  | { kind: 'admitted'; value: T };
export type NeedSettlement = Extract<Admission, { kind: 'need-settlement' }>;

export type ExpiryProviderSettlement = {
  done: Promise<void>;
  allowRelease(): void;
};

export type LeaseSessionEnd = Readonly<{
  /**
   * Ends sessions and retained execution hosts owned by `leaseId` under their execution locks.
   * Clears live sessions' device claims after teardown. Never rejects.
   */
  end: (
    leaseId: string,
    reason: LeaseEndReason,
    providerEnd?: ExpiryProviderSettlement,
  ) => Promise<void>;
  closingAt(address: string): SessionRef | undefined;
  forgetClosing(leaseId: string): void;
  settlementFor: (lifetime: SessionRef['lifetime']) => ExpirySettlement | undefined;
  /** Retries retained-host cleanup that failed after the registry removed its lease. */
  retryPending: () => Promise<void>;
  /**
   * Called when the daemon begins to leave. Shutdown tears every session down without taking an
   * execution lock, so no lease end may start a teardown after this, including one already queued
   * on the locks.
   */
  cancel: () => void;
  /** Resolves once every lease end already started has finished. */
  drain: () => Promise<void>;
}>;

const LEASE_END_RETRY_INTERVAL_MS = 10_000;

export const EXPIRY_TRANSITIONS = {
  expired: ['open', 'closing'],
  retry: ['cleanup-pending', 'closing'],
  settled: ['closing', 'retired'],
  incomplete: ['closing', 'cleanup-pending'],
} as const;

function transitionExpiry(event: keyof typeof EXPIRY_TRANSITIONS, cause: LeaseEndReason) {
  const [oldState, newState] = EXPIRY_TRANSITIONS[event];
  emitDiagnostic({
    level: 'info',
    phase: 'lease_expiry_transition',
    data: { actor: 'daemon', event, oldState, newState, cause },
  });
  return newState;
}

export function createLeaseSessionEnd(params: {
  env: HostEnvironment['env'];
  sessionStore: SessionStore;
  executionLocks: Map<string, Promise<unknown>>;
  teardownSession: SessionTeardown;
  cleanupSessionlessExecutionHost: PlatformResourceCleanup['cleanupSessionlessExecutionHost'];
  withinDiagnosticsScope?: (run: () => Promise<void>) => Promise<void>;
  confirmExpiredSessions?: (leaseId: string) => boolean;
}): LeaseSessionEnd {
  const { sessionStore, executionLocks, teardownSession } = params;
  let closing = false;
  const inFlight = new Map<string, Set<Promise<void>>>();
  const pending = new Map<
    string,
    {
      reason: LeaseEndReason;
      nextRetryAt: number;
      provider?: ExpiryProviderSettlement;
    }
  >();
  const closingRefs = new Map<string, SessionRef>();
  const forgetClosing = (leaseId: string) => {
    for (const [address, ref] of closingRefs) {
      if (ref.session.lease?.leaseId === leaseId) closingRefs.delete(address);
    }
  };
  const settlements = new WeakMap<SessionRef['lifetime'], ExpirySettlement>();
  const daemonContext = new AsyncResource('LeaseExpiry');
  const endLiveSessions = async (
    leaseId: string,
    reason: LeaseEndReason,
    attempted: Set<SessionRef['lifetime']>,
  ): Promise<void> => {
    const refs = sessionStore
      .leasedSessionRefs(leaseId)
      .filter(({ lifetime }) => !attempted.has(lifetime));
    await Promise.allSettled(
      refs.map(
        async (ref) =>
          await withRequestExecutionLockKeys(
            executionLocks,
            existingSessionExecutionLockKeys(ref.address, ref.session.device.id),
            async () => {
              if (closing) return;
              const current = sessionStore.resolveCurrent(ref);
              if (
                current?.lease?.leaseId !== leaseId ||
                current.device.id !== ref.session.device.id ||
                current.deviceClaim !== ref.session.deviceClaim
              )
                return;
              attempted.add(ref.lifetime);
              await endLeasedSession(
                sessionStore.refresh(ref),
                sessionStore,
                reason === 'PROVIDER_INSTANCE_ENDED'
                  ? (currentRef) => teardownSession(currentRef, reason)
                  : teardownSession,
                params.env,
              ).catch((error) =>
                emitDiagnostic({
                  level: 'warn',
                  phase: 'leased_session_end_cleanup_failed',
                  data: { session: ref.address, error: errorMessage(error) },
                }),
              );
            },
          ),
      ),
    );
  };

  const endUnderLocks = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
    const attempted = new Set<SessionRef['lifetime']>();
    await endLiveSessions(leaseId, reason, attempted);
    // A close queued before this lease end can retire its session while we wait for its locks.
    const retainedHosts = sessionStore.listRetainedExecutionHosts(leaseId);
    await Promise.all(
      retainedHosts.map(async (host) => {
        try {
          await withRequestExecutionLockKeys(
            executionLocks,
            existingSessionExecutionLockKeys(host.address, host.device.id),
            async () => {
              if (closing || !sessionStore.ownsRetainedExecutionHost(host)) return;
              if (!sessionStore.findByDevice(host.device.id)) {
                await params.cleanupSessionlessExecutionHost(host.device);
              }
              sessionStore.releaseRetainedExecutionHost(host);
            },
          );
        } catch (error) {
          emitDiagnostic({
            level: 'warn',
            phase: 'retained_execution_host_cleanup_failed',
            data: { leaseId, reason, deviceId: host.device.id, error: errorMessage(error) },
          });
        }
      }),
    );
    // A reopen can publish its same-lease session while retained-host cleanup waits for the device.
    await endLiveSessions(leaseId, reason, attempted);
  };

  const run = async (
    leaseId: string,
    reason: LeaseEndReason,
    provider?: ExpiryProviderSettlement,
  ): Promise<void> => {
    try {
      await endUnderLocks(leaseId, reason);
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'leased_session_end_failed',
        data: { leaseId, reason, error: errorMessage(error) },
      });
    } finally {
      if (
        !closing &&
        sessionStore.listRetainedExecutionHosts(leaseId).length === 0 &&
        sessionStore.leasedSessionRefs(leaseId).length === 0
      ) {
        pending.delete(leaseId);
      } else if (!closing) {
        pending.set(leaseId, {
          reason,
          provider,
          nextRetryAt: Date.now() + LEASE_END_RETRY_INTERVAL_MS,
        });
      }
    }
  };

  const registerExpiry = (
    leaseId: string,
    cleanup: Promise<boolean>,
    provider?: ExpiryProviderSettlement,
  ) => {
    let reported = false;
    const done = cleanup.then(async (retired) => {
      if (!retired) return false;
      const settled = params.confirmExpiredSessions?.(leaseId) ?? true;
      if (settled) forgetClosing(leaseId);
      provider?.allowRelease();
      await provider?.done;
      if (settled) return true;
      const confirmed = params.confirmExpiredSessions?.(leaseId) ?? true;
      if (confirmed) forgetClosing(leaseId);
      return confirmed;
    });
    const settleExpiredLifetime = (lifetime: SessionRef['lifetime']) => {
      settlements.set(lifetime, {
        done,
        takeReceipt: () => {
          if (reported) return false;
          reported = true;
          return true;
        },
      });
    };
    for (const ref of sessionStore.leasedSessionRefs(leaseId)) {
      closingRefs.set(ref.address, ref);
    }
    for (const ref of closingRefs.values()) {
      if (ref.session.lease?.leaseId === leaseId) settleExpiredLifetime(ref.lifetime);
    }
  };

  const end = async (
    leaseId: string,
    reason: LeaseEndReason,
    providerEnd?: ExpiryProviderSettlement,
  ): Promise<void> => {
    if (closing && !providerEnd) return;
    const expiry = reason === 'LEASE_EXPIRED';
    if (expiry && inFlight.has(leaseId)) return;
    const previous = pending.get(leaseId);
    const provider = providerEnd ?? previous?.provider;
    pending.set(leaseId, { reason, provider, nextRetryAt: 0 });
    const settle = async () => {
      if (expiry) transitionExpiry(previous ? 'retry' : 'expired', reason);
      await run(leaseId, reason, provider);
      const retired = !closing && !pending.has(leaseId);
      return expiry
        ? transitionExpiry(retired ? 'settled' : 'incomplete', reason) === 'retired'
        : retired;
    };
    const runScoped = async (): Promise<boolean> => {
      let retired = false;
      const cleanup = async () => {
        retired = await settle();
      };
      await (params.withinDiagnosticsScope?.(cleanup) ?? cleanup()).catch((error) => {
        emitDiagnostic({
          level: 'warn',
          phase: 'leased_session_end_failed',
          data: { reason, error: errorMessage(error) },
        });
      });
      return retired;
    };
    // This promise enters a daemon context on its next turn, with no inherited request locks.
    const cleanup = expiry
      ? daemonContext.runInAsyncScope(() => Promise.resolve().then(runScoped))
      : runScoped();
    const ending = cleanup.then(() => {});
    if (expiry) registerExpiry(leaseId, cleanup, provider);
    const running = inFlight.get(leaseId) ?? new Set<Promise<void>>();
    running.add(ending);
    inFlight.set(leaseId, running);
    try {
      await ending;
    } finally {
      running.delete(ending);
      if (running.size === 0) inFlight.delete(leaseId);
    }
  };

  return {
    end,
    closingAt: (address) => closingRefs.get(address),
    forgetClosing,
    settlementFor: (lifetime) => settlements.get(lifetime),
    retryPending: async () => {
      await Promise.all(
        Array.from(pending, async ([leaseId, { reason, nextRetryAt }]) => {
          if (!inFlight.has(leaseId) && Date.now() >= nextRetryAt) await end(leaseId, reason);
        }),
      );
    },
    cancel: () => {
      closing = true;
    },
    drain: async () => {
      await Promise.allSettled(Array.from(inFlight.values()).flatMap((running) => [...running]));
    },
  };
}

export async function awaitExpiry(
  done: Promise<boolean>,
  signal: AbortSignal,
  deadline: number,
): Promise<boolean> {
  signal.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  if (!Number.isFinite(remaining)) return await awaitWithSignal(done, signal);
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), remaining);
  try {
    return await awaitWithSignal(done, AbortSignal.any([signal, budget.signal]));
  } catch (error) {
    if (signal.aborted || !budget.signal.aborted) throw error;
    return false;
  } finally {
    clearTimeout(timer);
  }
}
