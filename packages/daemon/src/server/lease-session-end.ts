import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { errorMessage } from '@agent-device/kernel/errors';
import type { SessionStore } from '../core/session-store.ts';
import type { PlatformResourceCleanup } from '../core/platform-resource-cleanup.ts';
import {
  endLeasedSession,
  type LeaseEndReason,
  type SessionTeardown,
} from '../sessions/lease-lifecycle.ts';
import { existingSessionExecutionLockKeys } from './request-binding.ts';
import { withRequestExecutionLockKeys } from './request-execution-locks.ts';

export type LeaseSessionEnd = Readonly<{
  /**
   * Ends sessions and retained execution hosts owned by `leaseId` under their execution locks.
   * Clears live sessions' device claims after teardown. Never rejects.
   */
  end: (leaseId: string, reason: LeaseEndReason) => Promise<void>;
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

export function createLeaseSessionEnd(params: {
  env: HostEnvironment['env'];
  sessionStore: SessionStore;
  executionLocks: Map<string, Promise<unknown>>;
  teardownSession: SessionTeardown;
  cleanupSessionlessExecutionHost: PlatformResourceCleanup['cleanupSessionlessExecutionHost'];
  withinDiagnosticsScope?: (run: () => Promise<void>) => Promise<void>;
}): LeaseSessionEnd {
  const { sessionStore, executionLocks, teardownSession } = params;
  let closing = false;
  const inFlight = new Map<string, Set<Promise<void>>>();
  const pending = new Map<string, { reason: LeaseEndReason; nextRetryAt: number }>();

  const endLiveSessions = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
    const refs = sessionStore.listRefs().filter((ref) => ref.session.lease?.leaseId === leaseId);
    await Promise.all(
      refs.map(
        async (ref) =>
          await withRequestExecutionLockKeys(
            executionLocks,
            existingSessionExecutionLockKeys(ref.address, ref.session.device.id),
            async () => {
              if (closing) return;
              if (sessionStore.resolveCurrent(ref)?.lease?.leaseId !== leaseId) return;
              await endLeasedSession(
                sessionStore.refresh(ref),
                sessionStore,
                teardownSession,
                reason,
                params.env,
              );
            },
          ),
      ),
    );
  };

  const endUnderLocks = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
    await endLiveSessions(leaseId, reason);
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
    await endLiveSessions(leaseId, reason);
  };

  const run = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
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
        !sessionStore.listRefs().some((ref) => ref.session.lease?.leaseId === leaseId)
      ) {
        pending.delete(leaseId);
      } else if (!closing) {
        pending.set(leaseId, { reason, nextRetryAt: Date.now() + LEASE_END_RETRY_INTERVAL_MS });
      }
    }
  };

  const end = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
    if (closing) return;
    pending.set(leaseId, { reason, nextRetryAt: 0 });
    const ending = params.withinDiagnosticsScope
      ? params.withinDiagnosticsScope(async () => await run(leaseId, reason))
      : run(leaseId, reason);
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
