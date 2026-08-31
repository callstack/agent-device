import { SessionStore } from '../../daemon/session-store.ts';
import { resolveDaemonPaths } from '../../daemon/config.ts';
import { createDeviceClaimReconciler } from '../../daemon/device-claim-reconciliation.ts';
import { createDaemonRecoveryPlatformScope } from '../../daemon/platform-request-scope.ts';
import {
  releaseProvenStaleDeviceClaims,
  type DeviceClaimReconciler,
  type DeviceClaimStaleReleaseOutcome,
} from '../../daemon/device-claims.ts';
import type { DeviceClaimSelectors } from '../../daemon/device-claim-inspection.ts';
import { createPlatformRuntimeGateway } from '../../platform-runtime.ts';
import { createOwnedProcessRecordStore } from '@agent-device/host-kit/process';

export type StaleClaimRecovery = {
  reconcile: DeviceClaimReconciler;
  dispose(): Promise<void>;
};

/**
 * Daemonless `device release --stale`: settles each provably dead owner
 * through the same reconciliation transaction the daemon uses at `open` and
 * startup — resources first, claim last — without requiring the (typically
 * dead) owner daemon, or any daemon, to be running.
 */
export async function runStaleDeviceClaimRelease(
  selectors: DeviceClaimSelectors,
  composeRecovery: (stateDir: string) => StaleClaimRecovery = composeStaleClaimRecovery,
): Promise<DeviceClaimStaleReleaseOutcome[]> {
  return await releaseProvenStaleDeviceClaims({
    selectors,
    reconcile: async (claim) => {
      const recovery = composeRecovery(claim.stateDir);
      try {
        return await recovery.reconcile(claim);
      } finally {
        await recovery.dispose();
      }
    },
  });
}

/**
 * Recovery is composed per claim, bound to the stale owner's recorded state
 * dir: the owned-process record store and session artifact paths must be the
 * dead owner's, never the caller's. One caller-scoped store would let a
 * foreign claim's cleanup clear a same-named live session's records in the
 * caller's state dir. Local-only gateway: claims exist only for local
 * devices, so provider runtimes stay out of the composition entirely.
 */
function composeStaleClaimRecovery(stateDir: string): StaleClaimRecovery {
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
    reconcile: createDeviceClaimReconciler({
      gateway,
      scope: createDaemonRecoveryPlatformScope(),
    }),
    dispose: async () => {
      await gateway.shutdown();
    },
  };
}
