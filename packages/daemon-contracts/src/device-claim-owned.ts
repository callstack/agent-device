import type { EnvMap } from '@agent-device/kernel/source-value';
import { ownerIdentityMatches } from '@agent-device/host-kit/process';
import { inspectDeviceClaimFile, type InspectedDeviceClaim } from './device-claim-inspection.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { DeviceClaim, DeviceClaimSessionOwnership } from './device-claim-record.ts';
import { withDeviceClaimLock } from './device-claim-store.ts';

/**
 * Runs one claim write under the claim lock, for the owner that acquired it, and reports the record
 * that took the device when it is no longer the one that ownership took.
 */
export async function writeOwnedDeviceClaim<O, L>(
  ownership: DeviceClaimSessionOwnership,
  env: EnvMap,
  act: (claim: DeviceClaim, claimPath: string) => O,
  lost: (conflict: InspectedDeviceClaim | undefined) => L,
): Promise<O | L> {
  return await withDeviceClaimLock(ownership.deviceKey, env, async () => {
    const claimPath = resolveDeviceClaimPath(ownership.deviceKey, env);
    const inspected = inspectDeviceClaimFile(claimPath);
    if (!inspected) return lost(undefined);
    const claim = inspected.claim;
    if (!claim || !claimMatchesOwnership(claim, ownership)) return lost(inspected);
    return act(claim, claimPath);
  });
}

function claimMatchesOwnership(
  claim: DeviceClaim,
  ownership: DeviceClaimSessionOwnership,
): boolean {
  return (
    claim.ownerToken === ownership.ownerToken &&
    ownerIdentityMatches(
      { pid: claim.ownerPid, startTime: claim.ownerStartTime },
      { pid: ownership.ownerPid, startTime: ownership.ownerStartTime },
    )
  );
}
