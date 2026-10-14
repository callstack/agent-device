import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { errorMessage } from '@agent-device/kernel/errors';
import {
  endLeasedSession,
  type LeaseEndReason,
  type SessionTeardown,
} from '../../sessions/lease-lifecycle.ts';
import { existingSessionExecutionLockKeys } from '../request-binding.ts';
import { withRequestExecutionLockKeys } from '../request-execution-locks.ts';
import type { SessionStore } from '../../core/session-store.ts';

export type LeaseSessionEnd = Readonly<{
  /**
   * Ends every session opened under `leaseId` and clears its device claim, each inside that
   * session's execution lock pair so a command still running on it finishes first. Never rejects.
   */
  end: (leaseId: string, reason: LeaseEndReason) => Promise<void>;
  /**
   * Called when the daemon begins to leave. Shutdown tears every session down without taking an
   * execution lock, so no lease end may start a teardown after this, including one already queued
   * on the locks.
   */
  cancel: () => void;
  /** Resolves once every lease end already started has finished. */
  drain: () => Promise<void>;
}>;

export function createLeaseSessionEnd(params: {
  sessionStore: SessionStore;
  executionLocks: Map<string, Promise<unknown>>;
  teardownSession: SessionTeardown;
  withinDiagnosticsScope?: (run: () => Promise<void>) => Promise<void>;
}): LeaseSessionEnd {
  const { sessionStore, executionLocks, teardownSession } = params;
  let closing = false;
  const inFlight = new Set<Promise<void>>();

  const endUnderLocks = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
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
              );
            },
          ),
      ),
    );
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
    }
  };

  return {
    end: async (leaseId, reason) => {
      if (closing) return;
      const ending = params.withinDiagnosticsScope
        ? params.withinDiagnosticsScope(async () => await run(leaseId, reason))
        : run(leaseId, reason);
      inFlight.add(ending);
      try {
        await ending;
      } finally {
        inFlight.delete(ending);
      }
    },
    cancel: () => {
      closing = true;
    },
    drain: async () => {
      await Promise.allSettled(inFlight);
    },
  };
}
