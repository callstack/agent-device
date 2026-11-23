import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
import { AsyncResource } from 'node:async_hooks';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { settleWithin } from '@agent-device/host-kit/settle-within';
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
      leaseId: string;
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
  finishShutdown: (failedLeases: Map<string, string[]>, timeoutMs: number) => Promise<void>;
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

export function createLeaseSessionEnd(params: {
  env: HostEnvironment['env'];
  sessionStore: SessionStore;
  executionLocks: Map<string, Promise<unknown>>;
  teardownSession: SessionTeardown;
  cleanupSessionlessExecutionHost: PlatformResourceCleanup['cleanupSessionlessExecutionHost'];
  withinDiagnosticsScope?: (run: () => Promise<void>) => Promise<void>;
  confirmExpiredSessions?: (leaseId: string) => boolean;
  onClaimReleaseUnconfirmed?: (leaseId: string) => void;
}): LeaseSessionEnd {
  const { sessionStore, executionLocks, teardownSession } = params;
  let closing = false;
  const inFlight = new Map<string, Set<Promise<void>>>();
  const pending = new Map<
    string,
    {
      reason: LeaseEndReason;
      nextRetryAt?: number;
      provider?: ExpiryProviderSettlement;
    }
  >();
  const closingRefs = new Map<string, SessionRef>();
  const collectClosingRefs = (leaseId: string) => {
    for (const ref of sessionStore.leasedSessionRefs(leaseId)) closingRefs.set(ref.address, ref);
    return [...closingRefs.values()].filter((ref) => ref.session.lease?.leaseId === leaseId);
  };
  const forgetClosing = (leaseId: string) => {
    for (const [address, ref] of closingRefs) {
      if (ref.session.lease?.leaseId === leaseId) closingRefs.delete(address);
    }
  };
  const settlements = new WeakMap<SessionRef['lifetime'], ExpirySettlement>();
  const daemonContext = new AsyncResource('LeaseExpiry');
  const diagnosticIdentity = ({ session }: SessionRef) => ({
    session: session.name,
    deviceKey: session.lease?.deviceKey,
    leaseId: params.withinDiagnosticsScope ? session.lease?.leaseId : undefined,
  });
  const teardownForLeaseEnd = async (ref: SessionRef, reason: LeaseEndReason) => {
    const ended = { phase: 'leased_session_ended', data: { reason, ...diagnosticIdentity(ref) } };
    if (reason !== 'PROVIDER_INSTANCE_ENDED') {
      emitDiagnostic(ended);
      await teardownSession(ref);
      return;
    }
    try {
      await teardownSession(ref);
    } catch (error) {
      const failedSteps = error instanceof AppError ? error.details?.failedSteps : undefined;
      emitDiagnostic({
        ...ended,
        level: 'warn',
        data: {
          ...ended.data,
          failedSteps: failedSteps ?? ['application_lifecycle'],
          error: errorMessage(error),
        },
      });
      throw error;
    }
    emitDiagnostic(ended);
  };
  const transitionExpiry = (
    event: keyof typeof EXPIRY_TRANSITIONS,
    refs: readonly SessionRef[],
  ) => {
    const [oldState, newState] = EXPIRY_TRANSITIONS[event];
    const transition = { actor: 'daemon', event, oldState, newState, cause: 'LEASE_EXPIRED' };
    for (const ref of refs) {
      emitDiagnostic({
        phase: 'lease_expiry_transition',
        data: { ...transition, ...diagnosticIdentity(ref) },
      });
    }
    return newState;
  };
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
              const outcome = await endLeasedSession(
                sessionStore.refresh(ref),
                sessionStore,
                (currentRef) => teardownForLeaseEnd(currentRef, reason),
                params.env,
              ).catch((error) =>
                emitDiagnostic({
                  level: 'warn',
                  phase: 'leased_session_end_cleanup_failed',
                  data: { session: ref.address, error: errorMessage(error) },
                }),
              );
              if (outcome === 'claim-release-unconfirmed') {
                const currentEnd = pending.get(leaseId);
                if (currentEnd) delete currentEnd.nextRetryAt;
                params.onClaimReleaseUnconfirmed?.(leaseId);
                emitDiagnostic({
                  level: 'warn',
                  phase: 'lease_release_unknown',
                  data: { leaseId, reason: 'device-claim-release-unconfirmed' },
                });
              }
            },
          ),
      ),
    );
  };

  const endRetainedHosts = async (leaseId: string, reason: LeaseEndReason, shutdown = false) => {
    // A close queued before this lease end can retire its session while we wait for its locks.
    const retainedHosts = sessionStore.listRetainedExecutionHosts(leaseId);
    await Promise.all(
      retainedHosts.map(async (host) => {
        try {
          const stop = async () => {
            if (!sessionStore.ownsRetainedExecutionHost(host)) return;
            if (!sessionStore.findByDevice(host.device.id)) {
              await params.cleanupSessionlessExecutionHost(host.device);
            }
            sessionStore.releaseRetainedExecutionHost(host);
          };
          if (shutdown) return await stop();
          await withRequestExecutionLockKeys(
            executionLocks,
            existingSessionExecutionLockKeys(host.address, host.device.id),
            async () => {
              if (!closing) await stop();
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
  };

  const endUnderLocks = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
    const attempted = new Set<SessionRef['lifetime']>();
    await endLiveSessions(leaseId, reason, attempted);
    await endRetainedHosts(leaseId, reason);
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
      if (cleanupConfirmed(leaseId)) {
        pending.delete(leaseId);
        if (reason === 'LEASE_RELEASED' && !provider) params.confirmExpiredSessions?.(leaseId);
      } else if (pending.get(leaseId)?.nextRetryAt === undefined) {
        provider?.allowRelease();
      } else if (!closing) {
        pending.set(leaseId, {
          reason,
          provider,
          nextRetryAt: Date.now() + LEASE_END_RETRY_INTERVAL_MS,
        });
      }
    }
  };

  const cleanupConfirmed = (leaseId: string) =>
    sessionStore.listRetainedExecutionHosts(leaseId).length === 0 &&
    sessionStore.leasedSessionRefs(leaseId).length === 0;

  const confirmSessionCleanup = (leaseId: string, provider?: ExpiryProviderSettlement) => {
    const confirmed = params.confirmExpiredSessions?.(leaseId) ?? true;
    if (confirmed) forgetClosing(leaseId);
    provider?.allowRelease();
    return confirmed;
  };

  const registerExpiry = (
    leaseId: string,
    refs: readonly SessionRef[],
    cleanup: Promise<boolean>,
    provider?: ExpiryProviderSettlement,
  ) => {
    let reported = false;
    const done = cleanup.then(async (retired) => {
      if (!retired) return false;
      const settled = confirmSessionCleanup(leaseId, provider);
      await provider?.done;
      if (settled) return true;
      const confirmed = params.confirmExpiredSessions?.(leaseId) ?? true;
      if (confirmed) forgetClosing(leaseId);
      return confirmed;
    });
    const settlement: ExpirySettlement = {
      done,
      takeReceipt: () => {
        if (reported) return false;
        reported = true;
        return true;
      },
    };
    for (const { lifetime } of refs) settlements.set(lifetime, settlement);
  };

  const end = async (
    leaseId: string,
    reason: LeaseEndReason,
    providerEnd?: ExpiryProviderSettlement,
  ): Promise<void> => {
    if (closing && !providerEnd) return;
    const expiry = reason === 'LEASE_EXPIRED';
    const previous = pending.get(leaseId);
    const provider = providerEnd ?? previous?.provider;
    const settlement = expiry || provider !== undefined;
    const existing = inFlight.get(leaseId);
    if (settlement && existing) {
      if (!expiry) await Promise.all(existing);
      return;
    }
    pending.set(leaseId, { reason, provider, nextRetryAt: 0 });
    if (closing) return;
    const refs = settlement ? collectClosingRefs(leaseId) : [];
    const runScoped = async (): Promise<boolean> => {
      let retired = false;
      const cleanup = async () => {
        if (expiry) transitionExpiry(previous ? 'retry' : 'expired', refs);
        await run(leaseId, reason, provider);
        retired = !pending.has(leaseId);
        if (expiry)
          retired = transitionExpiry(retired ? 'settled' : 'incomplete', refs) === 'retired';
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
    const cleanup = settlement
      ? daemonContext.runInAsyncScope(() => Promise.resolve().then(runScoped))
      : runScoped();
    const ending = cleanup.then(() => {});
    if (settlement) registerExpiry(leaseId, refs, cleanup, provider);
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
    finishShutdown: async (failedLeases, timeoutMs) => {
      await settleWithin(
        async () =>
          await Promise.all(
            [...pending].map(async ([leaseId, { reason }]) => {
              if (!failedLeases.has(leaseId)) await endRetainedHosts(leaseId, reason, true);
            }),
          ),
        timeoutMs,
      );
      for (const [leaseId, { provider }] of pending) {
        if (!failedLeases.has(leaseId) && cleanupConfirmed(leaseId)) {
          pending.delete(leaseId);
          confirmSessionCleanup(leaseId, provider);
          continue;
        }
        // Shutdown has retired the sessions. Provider disposal can proceed even if local effects remain.
        provider?.allowRelease();
        if (failedLeases.has(leaseId)) continue;
        const failedSteps = ['retained_execution_host'];
        failedLeases.set(leaseId, failedSteps);
        emitDiagnostic({
          phase: 'leased_session_ended',
          level: 'warn',
          data: { reason: 'DAEMON_SHUTDOWN', leaseId, failedSteps },
        });
      }
    },
    retryPending: async () => {
      await Promise.all(
        Array.from(pending, async ([leaseId, { reason, nextRetryAt }]) => {
          if (!inFlight.has(leaseId) && nextRetryAt !== undefined && Date.now() >= nextRetryAt)
            await end(leaseId, reason);
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
