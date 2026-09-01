import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { createOwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { createPlatformRuntimeGateway } from '../platform-runtime.ts';
import { resolveDaemonPaths } from './config.ts';
import { createDeviceClaimReconciler } from './device-claim-reconciliation.ts';
import type { DeviceClaimReconciler } from './device-claims.ts';
import { SessionStore } from './session-store.ts';

export type OwnerScopedClaimRecovery = {
  reconcile: DeviceClaimReconciler;
  dispose(): Promise<void>;
};

export type OwnerScopedClaimRecoveryComposer = (stateDir: string) => OwnerScopedClaimRecovery;

/**
 * The production entry for stale-claim reconciliation (#2168): every recovery
 * transaction is composed from the stale claim's own recorded state dir and
 * disposed afterwards. The owned-process record store and session artifact
 * paths must be the dead owner's, never the reconciling process's — recording
 * cleanup clears records by bare session id through the composed store, and
 * one caller-scoped store would let a foreign claim's recovery clear a
 * same-named live session's records.
 */
export function createOwnerScopedDeviceClaimReconciler(
  scope: PlatformRequestScope,
  composeRecovery?: OwnerScopedClaimRecoveryComposer,
): DeviceClaimReconciler {
  const compose =
    composeRecovery ?? ((stateDir) => composeOwnerScopedClaimRecovery(stateDir, scope));
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
): OwnerScopedClaimRecovery {
  const daemonPaths = resolveDaemonPaths(stateDir);
  const sessionStore = new SessionStore(daemonPaths.sessionsDir);
  const gateway = createPlatformRuntimeGateway({
    sessionsDir: daemonPaths.sessionsDir,
    ownedProcesses: createOwnedProcessRecordStore({
      stateDir: daemonPaths.baseDir,
      sessionsDir: daemonPaths.sessionsDir,
      resolveSessionDir: (sessionId) => sessionStore.resolveSessionDir(sessionId),
    }),
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: sessionStore.resolveAppLogPath(sessionId),
      pidPath: sessionStore.resolveAppLogPidPath(sessionId),
    }),
  });
  return {
    reconcile: createDeviceClaimReconciler({ gateway, scope }),
    dispose: async () => {
      await gateway.shutdown();
    },
  };
}
