import {
  resolveSessionDir,
  resolveSessionAppLogPath,
  resolveSessionAppLogPidPath,
} from './session-artifact-paths.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { JsonObject } from '@agent-device/contracts/client';
import { createOwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  flushDiagnosticsToSessionFile,
  toDiagnosticJson,
} from '@agent-device/host-kit/diagnostics';
import { resolveDaemonPaths } from './daemon-resolution.ts';
import {
  createDeviceClaimReconciler,
  type ClaimRecoveryInspection,
  type ClaimRecoveryRetentionReason,
} from './device-claim-reconciliation.ts';
import type { DeviceClaim, DeviceClaimReconciler } from './device-claims.ts';
import type { ClaimRecoveryGatewayFactory } from './claim-recovery-gateway.ts';

/**
 * How long a recovery transaction waits for its gateway to close. A gateway's shutdown stays
 * pending until every owner load it started settles, and a load the acquisition deadline abandoned
 * may never settle; past this budget the claim stays retained and the late close is handed to the
 * process owner so it is still awaited and observed. The budget is a dedicated cleanup grace that
 * runs even after `scope.signal` cancellation so normal fast gateway shutdown finishes inside the
 * transaction rather than spilling into background tracking.
 */
const DEVICE_CLAIM_RECOVERY_DISPOSE_BUDGET_MS = 5_000;

type ClaimRecoveryDisposalTracker = Readonly<{
  /** Records a recovery transaction from gateway composition through disposal settlement. */
  track(disposal: Promise<void>): void;
  /** Awaits every tracked recovery disposal, including any registered while draining. */
  drain(): Promise<void>;
}>;

/**
 * Process-lifetime owner for claim-recovery disposals, tracking each recovery transaction from
 * gateway composition through disposal settlement and late diagnostic flush.
 */
export function createClaimRecoveryDisposalTracker(): ClaimRecoveryDisposalTracker {
  const pending = new Set<Promise<void>>();
  return {
    track(disposal) {
      const tracked = disposal.then(
        () => {
          pending.delete(tracked);
        },
        () => {
          pending.delete(tracked);
        },
      );
      pending.add(tracked);
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.all(pending);
      }
    },
  };
}

export type OwnerScopedClaimRecovery = {
  reconcile: (
    claim: DeviceClaim,
    inspection?: ClaimRecoveryInspection,
  ) => ReturnType<DeviceClaimReconciler>;
  dispose(): Promise<void>;
};

export type OwnerScopedClaimRecoveryComposer = (stateDir: string) => OwnerScopedClaimRecovery;

/**
 * The production entry for stale-claim reconciliation (#2168): every recovery
 * transaction is composed from the stale claim's own recorded state dir and
 * disposed afterwards. The owned-process record store, session artifact paths,
 * and runtime gateway must be the dead owner's, never the reconciling
 * process's — recording cleanup clears records by bare session id through the
 * composed store, and one caller-scoped store would let a foreign claim's
 * recovery clear a same-named live session's records.
 *
 * The gateway itself arrives through `composeGateway`, which root composition
 * supplies: assembling a runtime gateway is the process root's act, and this
 * module keeps only the transaction — what to rebuild from, in what order, and
 * when to dispose it.
 */
export function createOwnerScopedDeviceClaimReconciler(
  params: Readonly<{
    scope: PlatformRequestScope;
    /** Optional claim-owner decision before gateway construction. */
    beforeGateway?: (
      claim: DeviceClaim,
    ) => ClaimRecoveryInspection | undefined | Promise<ClaimRecoveryInspection | undefined>;
    /** Root composition's per-transaction recovery gateway; used unless `composeRecovery` replaces it. */
    composeGateway: ClaimRecoveryGatewayFactory;
    /** Test seam replacing the whole per-claim composition, gateway included. */
    composeRecovery?: OwnerScopedClaimRecoveryComposer;
    /**
     * Process-lifetime sink for active recovery disposals, so the owning daemon or CLI awaits
     * every disposal — whether still inside its per-transaction grace or past it — before exiting.
     */
    trackDisposal: (disposal: Promise<void>) => void;
    /** Optional per-transaction disposal budget override, for tests that exercise the bound. */
    disposeBudgetMs?: number;
  }>,
): DeviceClaimReconciler {
  const disposeBudgetMs = params.disposeBudgetMs ?? DEVICE_CLAIM_RECOVERY_DISPOSE_BUDGET_MS;
  const compose =
    params.composeRecovery ??
    ((stateDir) => composeOwnerScopedClaimRecovery(stateDir, params.scope, params.composeGateway));
  return async (claim) => {
    const inspection = await params.beforeGateway?.(claim);
    if (inspection?.status === 'retained') return inspection;
    const { settleWithin } = await import('@agent-device/host-kit/settle-within');
    const recovery = compose(claim.stateDir);
    const { promise: trackedLifecycle, resolve: resolveTracked } = Promise.withResolvers<void>();
    // Track from gateway composition through disposal settlement so a daemon close that starts
    // while reconciliation is still in flight still sees this recovery gateway.
    params.trackDisposal(trackedLifecycle);
    let disposalTracked = false;
    try {
      let outcome:
        | { status: 'fulfilled'; result: Awaited<ReturnType<DeviceClaimReconciler>> }
        | { status: 'rejected'; error: unknown };
      try {
        outcome = { status: 'fulfilled', result: await recovery.reconcile(claim, inspection) };
      } catch (error) {
        outcome = { status: 'rejected', error };
      }
      const retainedReason: JsonObject =
        outcome.status === 'fulfilled' && outcome.result.status === 'retained'
          ? { retainedReason: outcome.result.reason }
          : {};
      const emit = (event: {
        level: 'info' | 'warn' | 'error';
        phase: string;
        data: JsonObject;
      }) => {
        try {
          params.scope.diagnostics.emit({
            ...event,
            data: {
              deviceKey: claim.deviceKey,
              ownerSession: claim.session,
              ...retainedReason,
              ...event.data,
            },
          });
        } catch {
          // ADR 0010: secondary diagnostic failures must preserve the reconciliation outcome.
        }
      };
      const flushLateDiagnostics = () => {
        try {
          flushDiagnosticsToSessionFile({ force: true });
        } catch {
          // ADR 0010: secondary diagnostic failures must preserve the reconciliation outcome.
        }
      };
      const disposal = Promise.resolve().then(async () => await recovery.dispose());
      let disposalPending = false;
      try {
        disposalPending = (await settleWithin(() => disposal, disposeBudgetMs)).kind === 'deadline';
      } catch (error) {
        emit({
          level: 'error',
          phase: 'device_claim_recovery_dispose_failed',
          data: failureData(error),
        });
        if (outcome.status === 'fulfilled' && outcome.result.status === 'reconciled') throw error;
      }
      if (disposalPending) {
        emit({
          level: 'warn',
          phase: 'device_claim_recovery_dispose_pending',
          data: { budgetMs: disposeBudgetMs },
        });
        const lateObservation = disposal.then(
          () => {
            emit({
              level: 'info',
              phase: 'device_claim_recovery_dispose_settled',
              data: { afterBudget: true },
            });
            flushLateDiagnostics();
          },
          (error: unknown) => {
            emit({
              level: 'error',
              phase: 'device_claim_recovery_dispose_failed',
              data: { afterBudget: true, ...failureData(error) },
            });
            flushLateDiagnostics();
          },
        );
        disposalTracked = true;
        void lateObservation.finally(resolveTracked);
      }
      if (outcome.status === 'rejected') throw outcome.error;
      if (disposalPending && outcome.result.status === 'reconciled') {
        return {
          status: 'retained',
          reason: 'recovery-dispose-pending' satisfies ClaimRecoveryRetentionReason,
        };
      }
      return outcome.result;
    } finally {
      if (!disposalTracked) resolveTracked();
    }
  };
}

function failureData(error: unknown): JsonObject {
  try {
    return { error: toDiagnosticJson(normalizeError(error)) };
  } catch {
    return { reason: 'diagnostic-data-unserializable' };
  }
}

/**
 * Local-only gateway per transaction: claims exist only for local devices, so
 * provider runtimes stay out of the composition, and every stateful piece the
 * gateway owns (app-log runtime handles, owned-process store) is instance
 * scoped — disposal shuts down only this transaction's handles.
 */
function composeOwnerScopedClaimRecovery(
  stateDir: string,
  scope: PlatformRequestScope,
  composeGateway: ClaimRecoveryGatewayFactory,
): OwnerScopedClaimRecovery {
  const daemonPaths = resolveDaemonPaths(stateDir);
  const gateway = composeGateway({
    stateDir: daemonPaths.baseDir,
    sessionsDir: daemonPaths.sessionsDir,
    ownedProcesses: createOwnedProcessRecordStore({
      stateDir: daemonPaths.baseDir,
      sessionsDir: daemonPaths.sessionsDir,
      resolveSessionDir: (sessionId) => resolveSessionDir(daemonPaths.sessionsDir, sessionId),
    }),
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: resolveSessionAppLogPath(daemonPaths.sessionsDir, sessionId),
      pidPath: resolveSessionAppLogPidPath(daemonPaths.sessionsDir, sessionId),
    }),
  });
  return {
    reconcile: createDeviceClaimReconciler({ gateway, scope }),
    dispose: async () => {
      await gateway.shutdown();
    },
  };
}
