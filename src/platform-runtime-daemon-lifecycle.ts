import type { PlatformOwnerLifecycle } from './daemon/platform-owner-lifecycle.ts';
import {
  configureAppleRunnerDeviceClaimAuthorityProbe,
  configureAppleRunnerLeaseOwnerStateDir,
} from './platform-runtime-apple-runner-owner.ts';
import {
  cleanupManagedWebRuntimeOrphans,
  resetAndroidSnapshotHelperRuntime,
} from './platform-runtime-resource-cleanup.ts';

/**
 * Root composition of the daemon's typed lifecycle-participation surface (#2333). This is the
 * one place that names the platform resource owners (the Apple runner owner, the Android
 * snapshot-helper and Web orphan cleanups, and legacy app-log marker recovery); the daemon holds
 * only the typed `PlatformOwnerLifecycle` contract.
 */
export const platformDaemonLifecycleOwners: PlatformOwnerLifecycle = Object.freeze({
  configureForDaemonLock: async (input) => {
    await configureAppleRunnerLeaseOwnerStateDir(input.stateDir);
    await configureAppleRunnerDeviceClaimAuthorityProbe(input.hasDeviceClaimAuthority);
  },
  clearDaemonLockConfiguration: async () => {
    await configureAppleRunnerLeaseOwnerStateDir(undefined);
    await configureAppleRunnerDeviceClaimAuthorityProbe(undefined);
  },
  recoverLegacyAppLogMarkers: async (sessionsDir) => {
    const { recoverLegacyAppLogMarkersAfterDaemonLock } =
      await import('./platform-runtime-operation-host.ts');
    return await recoverLegacyAppLogMarkersAfterDaemonLock(sessionsDir);
  },
  cleanupManagedWebOrphans: async (params) => {
    await cleanupManagedWebRuntimeOrphans(params);
  },
  resetAndroidSnapshotHelper: async () => {
    await resetAndroidSnapshotHelperRuntime();
  },
});
