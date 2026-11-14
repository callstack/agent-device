import path from 'node:path';
import { devicesOverlap, type DeviceIdentity } from '@agent-device/kernel/device';
import type { DeviceBootObservationService } from '@agent-device/contracts/device-boot';
import type { EnvMap } from '@agent-device/kernel/source-value';

import {
  deviceClaimRefusalReason,
  type DeviceClaimClassification,
  type DeviceClaimRefusalReason,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import {
  inspectDeviceClaimRecovery,
  type ClaimRecoveryRetentionReason,
} from './device-claim-reconciliation.ts';
import { inspectDeviceClaimOwnerSettlement } from './device-claim-settlement.ts';

/**
 * Whether a NEW session can take a device right now, answered through the same decisions an
 * acquisition applies rather than a second classifier. Claim counts answer "how many records name
 * this device"; this answers "will `open` accept it", which is what a caller choosing a device needs.
 *
 * The answer is an inspection, not a reservation: an owner can appear or die between it and the
 * caller's `open`, which decides for itself. Nothing here deletes, clears, or renews a claim.
 */
export type DeviceAcquirability = Readonly<{
  acquirable: boolean;
  /** Why the device is not acquirable now; absent exactly when `acquirable` is true. */
  blockedBy?: DeviceAcquirabilityBlockReason;
  /**
   * The owner to act on: the holder that blocks the device, or, when it is acquirable, the
   * reclaimable owner whose claim an acquisition would settle.
   */
  claim?: DeviceAcquirabilityOwner;
}>;

/**
 * Why the device is held, in the vocabulary the acquisition and release paths already use: an owner
 * that can still release the device, an owner the host cannot prove dead, an unreadable record, or a
 * durable resource the dead owner still owns that keeps its settlement pending (#4238).
 */
export type DeviceAcquirabilityBlockReason =
  | DeviceClaimRefusalReason
  | ClaimRecoveryRetentionReason;

/** The owner projection a caller needs to act on the answer. */
export type DeviceAcquirabilityOwner = Readonly<{
  fileName: string;
  classification: DeviceClaimClassification;
  deviceKey?: string;
  session?: string;
  workspace?: string;
  stateDir?: string;
}>;

/**
 * One device's acquirability, judged from the claims that concern it.
 *
 * A claim concerns the device when it is recorded against that device key, when it is recorded
 * against a device this one cannot be held apart from, or when it is a record that never decoded and
 * sits exactly where this device's key tells `open` to read. The middle case is why an acquisition of
 * a host-scoped device — one app of a macOS host, or one web session (ADR 0035) — refuses a live host
 * claim and settles a reclaimable one, and a host acquisition weighs its apps the same way.
 *
 * Each claim answers with the two halves an acquisition asks of a claim its caller does not own:
 * {@link inspectDeviceClaimOwnerSettlement}, the very decision `resolveExistingClaim` reaches
 * through, so a provably dead or superseded owner counts as acquirable here and there; then
 * {@link inspectDeviceClaimRecovery}, the pre-gateway check `open` and `device release --stale` run,
 * so a dead owner that still owns a recording blocks all three.
 *
 * A reporter that cannot reach the device — `device status` never touches one — omits
 * `observeDeviceBoot` and so reads no reboot as proof, answering as `boot`, `install` and `shutdown`
 * do: a live owner holds the device. `open` passes the observer and also takes a claim a reboot
 * invalidated.
 */
export async function inspectDeviceAcquirability(params: {
  device: DeviceIdentity;
  /** Every inspected claim to weigh, in a stable order; the ones that concern `device` are picked. */
  claims: readonly InspectedDeviceClaim[];
  env: EnvMap;
  observeDeviceBoot?: DeviceBootObservationService;
}): Promise<DeviceAcquirability> {
  const reclaimable: InspectedDeviceClaim[] = [];
  for (const inspected of claimsConcerningDevice(params.device, params.claims, params.env)) {
    const decision = await decideInspectedClaim(inspected, params.observeDeviceBoot);
    if (decision.status === 'blocked') return decision.outcome;
    if (decision.status === 'reclaimable') reclaimable.push(inspected);
  }
  const reclaimableClaim = reclaimable[0];
  return reclaimableClaim
    ? { acquirable: true, claim: ownerOf(reclaimableClaim) }
    : { acquirable: true };
}

function claimsConcerningDevice(
  device: DeviceIdentity,
  claims: readonly InspectedDeviceClaim[],
  env: EnvMap,
): InspectedDeviceClaim[] {
  const ownClaimFileName = path.basename(
    resolveDeviceClaimPath(canonicalLocalDeviceKey(device), env),
  );
  return claims.filter((entry) => {
    // A record that never decoded names no device, so it blocks exactly the device whose key hashes
    // to its file name — the one file `open` would read and refuse to guess at.
    if (!entry.claim) return entry.fileName === ownClaimFileName;
    return (
      entry.claim.device.family === device.family &&
      entry.claim.device.appleOs === device.appleOs &&
      devicesOverlap(entry.claim.device.id, device.id)
    );
  });
}

async function decideInspectedClaim(
  inspected: InspectedDeviceClaim,
  observeDeviceBoot: DeviceBootObservationService | undefined,
): Promise<{ status: 'blocked'; outcome: DeviceAcquirability } | { status: 'reclaimable' }> {
  const claim = inspected.claim;
  if (!claim) {
    return {
      status: 'blocked',
      outcome: {
        acquirable: false,
        blockedBy: 'claim-record-inconsistent',
        claim: ownerOf(inspected),
      },
    };
  }
  const owner = await inspectDeviceClaimOwnerSettlement({
    inspected,
    ...(observeDeviceBoot ? { observeDeviceBoot } : {}),
  });
  if (owner.status === 'conflicts') {
    return {
      status: 'blocked',
      outcome: {
        acquirable: false,
        blockedBy: deviceClaimRefusalReason(inspected.classification),
        claim: ownerOf(inspected),
      },
    };
  }
  const recovery = inspectDeviceClaimRecovery(claim);
  if (recovery.status === 'retained') {
    return {
      status: 'blocked',
      outcome: { acquirable: false, blockedBy: recovery.reason, claim: ownerOf(inspected) },
    };
  }
  // A reclaimable owner still owns a resource it never closed, and acquisition settles resources
  // before it clears the claim (#4238). `status` composes no recovery gateway, so it reports such a
  // device as pending disposal rather than guessing whether that recovery would succeed.
  const pendingDisposal = recovery.recoveryKinds[0];
  if (pendingDisposal !== undefined) {
    return {
      status: 'blocked',
      outcome: {
        acquirable: false,
        blockedBy: `${pendingDisposal}-cleanup-pending`,
        claim: ownerOf(inspected),
      },
    };
  }
  return { status: 'reclaimable' };
}

function ownerOf(inspected: InspectedDeviceClaim): DeviceAcquirabilityOwner {
  const claim = inspected.claim;
  return {
    fileName: inspected.fileName,
    classification: inspected.classification,
    ...(inspected.deviceKey ? { deviceKey: inspected.deviceKey } : {}),
    ...(claim
      ? { session: claim.session, workspace: claim.workspace, stateDir: claim.stateDir }
      : {}),
  };
}
