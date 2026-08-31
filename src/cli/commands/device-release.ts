import { SessionStore } from '../../daemon/session-store.ts';
import { resolveDaemonPaths } from '../../daemon/config.ts';
import { createDeviceClaimReconciler } from '../../daemon/device-claim-reconciliation.ts';
import { createDaemonRecoveryPlatformScope } from '../../daemon/platform-request-scope.ts';
import {
  releaseProvenStaleDeviceClaims,
  type DeviceClaimStaleReleaseOutcome,
} from '../../daemon/device-claims.ts';
import type { DeviceClaimSelectors } from '../../daemon/device-claim-inspection.ts';
import { createPlatformRuntimeGateway } from '../../platform-runtime.ts';
import { createOwnedProcessRecordStore } from '@agent-device/host-kit/process';

/**
 * Daemonless `device release --stale`: composes the same local platform
 * gateway and reconciliation transaction the daemon uses at `open` and
 * startup, so resources are settled through their exact-owner recovery paths
 * before the claim is cleared — without requiring the (typically dead) owner
 * daemon, or any daemon, to be running.
 */
export async function runStaleDeviceClaimRelease(
  selectors: DeviceClaimSelectors,
): Promise<DeviceClaimStaleReleaseOutcome[]> {
  const daemonPaths = resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR);
  const sessionStore = new SessionStore(daemonPaths.sessionsDir);
  const ownedProcesses = createOwnedProcessRecordStore({
    stateDir: daemonPaths.baseDir,
    sessionsDir: daemonPaths.sessionsDir,
    resolveSessionDir: (sessionId) => sessionStore.resolveSessionDir(sessionId),
  });
  // Local-only gateway: claims exist only for local devices, so provider
  // runtimes stay out of the composition entirely.
  const gateway = createPlatformRuntimeGateway({
    sessionsDir: daemonPaths.sessionsDir,
    ownedProcesses,
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: sessionStore.resolveAppLogPath(sessionId),
      pidPath: sessionStore.resolveAppLogPidPath(sessionId),
    }),
  });
  try {
    return await releaseProvenStaleDeviceClaims({
      selectors,
      reconcile: createDeviceClaimReconciler({
        gateway,
        scope: createDaemonRecoveryPlatformScope(),
      }),
    });
  } finally {
    await gateway.shutdown();
  }
}
