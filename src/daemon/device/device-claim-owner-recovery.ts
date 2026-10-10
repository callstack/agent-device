import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { createOwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { createDeviceClaimReconciler } from './device-claim-reconciliation.ts';
import type { DeviceClaimReconciler } from './device-claims.ts';
import type { ClaimRecoveryGatewayFactory } from './claim-recovery-gateway.ts';
import {
  resolveSessionDir,
  resolveSessionAppLogPath,
  resolveSessionAppLogPidPath,
} from '../session-artifact-paths.ts';

export type OwnerScopedClaimRecovery = {
  reconcile: DeviceClaimReconciler;
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
    /** Root composition's per-transaction recovery gateway; required unless a composer overrides it. */
    composeGateway: ClaimRecoveryGatewayFactory;
    /** Test seam replacing the whole per-claim composition, gateway included. */
    composeRecovery?: OwnerScopedClaimRecoveryComposer;
  }>,
): DeviceClaimReconciler {
  const compose =
    params.composeRecovery ??
    ((stateDir) => composeOwnerScopedClaimRecovery(stateDir, params.scope, params.composeGateway));
  return async (claim) => {
    const recovery = compose(claim.stateDir);
    try {
      return await recovery.reconcile(claim);
    } finally {
      await recovery.dispose();
    }
  };
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
    stateDir,
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
