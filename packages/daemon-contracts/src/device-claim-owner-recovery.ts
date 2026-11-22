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
 * may never settle; past this budget the claim stays retained and the late close is still observed.
 */
const DEVICE_CLAIM_RECOVERY_DISPOSE_BUDGET_MS = 5_000;

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
  }>,
): DeviceClaimReconciler {
  const compose =
    params.composeRecovery ??
    ((stateDir) => composeOwnerScopedClaimRecovery(stateDir, params.scope, params.composeGateway));
  return async (claim) => {
    const inspection = await params.beforeGateway?.(claim);
    if (inspection?.status === 'retained') return inspection;
    const recovery = compose(claim.stateDir);
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
    const emit = (event: { level: 'warn' | 'error'; phase: string; data: JsonObject }) => {
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
    const { settleWithin } = await import('@agent-device/host-kit/settle-within');
    const disposal = Promise.resolve().then(async () => await recovery.dispose());
    let disposalPending = false;
    try {
      disposalPending =
        (await settleWithin(() => disposal, DEVICE_CLAIM_RECOVERY_DISPOSE_BUDGET_MS)).kind ===
        'deadline';
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
        data: { budgetMs: DEVICE_CLAIM_RECOVERY_DISPOSE_BUDGET_MS },
      });
      disposal.catch((error: unknown) => {
        emit({
          level: 'error',
          phase: 'device_claim_recovery_dispose_failed',
          data: { afterBudget: true, ...failureData(error) },
        });
        try {
          flushDiagnosticsToSessionFile({ force: true });
        } catch {
          // ADR 0010: secondary diagnostic failures must preserve the reconciliation outcome.
        }
      });
    }
    if (outcome.status === 'rejected') throw outcome.error;
    if (disposalPending && outcome.result.status === 'reconciled') {
      return {
        status: 'retained',
        reason: 'recovery-dispose-pending' satisfies ClaimRecoveryRetentionReason,
      };
    }
    return outcome.result;
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
