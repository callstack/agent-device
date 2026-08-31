import {
  createOwnerScopedDeviceClaimReconciler,
  type OwnerScopedClaimRecoveryComposer,
} from '../../daemon/device-claim-owner-recovery.ts';
import { createDaemonRecoveryPlatformScope } from '../../daemon/platform-request-scope.ts';
import {
  releaseProvenStaleDeviceClaims,
  type DeviceClaimStaleReleaseOutcome,
} from '../../daemon/device-claims.ts';
import type { DeviceClaimSelectors } from '../../daemon/device-claim-inspection.ts';

/**
 * Daemonless `device release --stale`: settles each provably dead owner
 * through the same owner-scoped reconciliation the daemon uses at `open` and
 * startup — recovery composed from the stale claim's own state dir, resources
 * settled first, claim cleared last — without requiring the (typically dead)
 * owner daemon, or any daemon, to be running.
 */
export async function runStaleDeviceClaimRelease(
  selectors: DeviceClaimSelectors,
  composeRecovery?: OwnerScopedClaimRecoveryComposer,
): Promise<DeviceClaimStaleReleaseOutcome[]> {
  return await releaseProvenStaleDeviceClaims({
    selectors,
    reconcile: createOwnerScopedDeviceClaimReconciler(
      createDaemonRecoveryPlatformScope(),
      composeRecovery,
    ),
  });
}
