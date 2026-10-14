import {
  createOwnerScopedDeviceClaimReconciler,
  type OwnerScopedClaimRecoveryComposer,
} from '@agent-device/daemon/device/device-claim-owner-recovery';
import { createClaimRecoveryGateway } from '../../platform-runtime-claim-recovery.ts';
import { createDaemonRecoveryPlatformScope } from '@agent-device/daemon/platform-request-scope';
import {
  releaseProvenStaleDeviceClaims,
  type DeviceClaimStaleReleaseOutcome,
} from '@agent-device/daemon/device/device-claims';
import type { DeviceClaimSelectors } from '@agent-device/daemon/device/device-claim-inspection';

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
    reconcile: createOwnerScopedDeviceClaimReconciler({
      scope: createDaemonRecoveryPlatformScope(),
      composeGateway: createClaimRecoveryGateway,
      composeRecovery,
    }),
  });
}
