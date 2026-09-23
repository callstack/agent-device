import fs from 'node:fs';
import type { DeviceBootObservationService } from '@agent-device/contracts/device-boot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  ownerIdentityMatches,
  type readCurrentOwnerIdentity,
} from '@agent-device/host-kit/process';
import {
  deviceClaimOwnerCannotRelease,
  inspectDeviceClaimFile,
  type DeviceClaimClassification,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import {
  emitClaimReleasedAfterDeviceReboot,
  rebootedDeviceClaim,
  type TakenOverDeviceClaim,
} from './device-claim-reboot.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import {
  ownershipFromClaim,
  type DeviceClaim,
  type DeviceClaimSessionOwnership,
} from './device-claim-record.ts';
import { writeDeviceClaim } from './device-claim-store.ts';

/**
 * What the claim file says before an acquisition writes its own record. `available` means the
 * caller may claim the device, and `tookOver` names the stale claim it replaced; `held` means the
 * same session already owns the device and keeps its ownership token.
 */
export type ExistingClaimResolution =
  | { status: 'available'; tookOver?: TakenOverDeviceClaim }
  | { status: 'held'; ownership: DeviceClaimSessionOwnership }
  | { status: 'conflict'; conflict: InspectedDeviceClaim };

export type DeviceClaimReconciliationResult =
  | { status: 'reconciled' }
  | { status: 'retained'; reason: string };

export type DeviceClaimReconciler = (
  claim: DeviceClaim,
) => Promise<DeviceClaimReconciliationResult>;

/**
 * Settles the claim file an acquisition found, and decides whether this caller may write its own.
 * The recorded owner's own state answers first — a dead, unreachable, or superseded owner is
 * settled exactly as `device release --stale` settles it. A claim whose owner can still release it
 * clears only on the device's own evidence, because a device that rebooted after the claim was
 * taken destroyed the runner, the app, and the accessibility connection the claim described.
 */
export async function resolveExistingClaim(params: {
  device: DeviceInfo;
  deviceKey: string;
  owner: ReturnType<typeof readCurrentOwnerIdentity>;
  session: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
  observeDeviceBoot?: DeviceBootObservationService;
}): Promise<ExistingClaimResolution> {
  const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(params.deviceKey));
  if (!existing) return { status: 'available' };
  if (
    existing.claim &&
    isAbandonedClaimOfThisDaemon(existing.claim, params.stateDir, params.owner)
  ) {
    emitClaimSupersede(params.deviceKey, existing.claim);
    return { status: 'available' };
  }
  if (existing.claim && isCurrentClaimOwner(existing.claim, params, params.owner)) {
    return { status: 'held', ownership: renewHeldClaim(existing.claim) };
  }
  return await settleForeignClaim(existing, params);
}

/**
 * An owner asking for the device it already holds vouches for that device as of now, which is what
 * the reboot bound measures. Without this write, an owner that reopened its app after a reboot would
 * keep a claim stamped before the reboot, and the next foreign `open` would read that stamp as
 * proof of a device nobody owns and take it out from under a session that is demonstrably running.
 */
function renewHeldClaim(claim: DeviceClaim): DeviceClaimSessionOwnership {
  if (claim.updatedAtMs >= Date.now()) return ownershipFromClaim(claim);
  const renewed: DeviceClaim = { ...claim, updatedAtMs: Date.now() };
  writeDeviceClaim(renewed);
  return ownershipFromClaim(renewed);
}

/**
 * A settled foreign claim clears through the same transaction `device release --stale` and the
 * startup sweep use: durable resources first, claim last, so a resource still owned by the foreign
 * session keeps the device claimed rather than handing it over mid-cleanup.
 */
async function settleForeignClaim(
  existing: InspectedDeviceClaim,
  params: {
    device: DeviceInfo;
    deviceKey: string;
    reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
    observeDeviceBoot?: DeviceBootObservationService;
  },
): Promise<ExistingClaimResolution> {
  const claim = existing.claim;
  if (!claim) {
    emitClaimConflict(params.deviceKey, existing);
    return { status: 'conflict', conflict: existing };
  }
  const settlement = await foreignClaimSettlement({
    classification: existing.classification,
    claim,
    device: params.device,
    observeDeviceBoot: params.observeDeviceBoot,
  });
  if (!settlement.settles) {
    emitClaimConflict(params.deviceKey, existing);
    return { status: 'conflict', conflict: existing };
  }
  const reconciliation = await settleVerifiedOrphanedClaim(
    claim,
    params.reconcileOrphanedDeviceClaim,
  );
  if (reconciliation.status === 'retained') {
    emitClaimConflict(params.deviceKey, existing, reconciliation.reason);
    return { status: 'conflict', conflict: existing };
  }
  if (!settlement.tookOver) return { status: 'available' };
  emitClaimReleasedAfterDeviceReboot({
    deviceKey: params.deviceKey,
    claim,
    bootedAtMs: settlement.tookOver.bootedAtMs,
  });
  return { status: 'available', tookOver: settlement.tookOver };
}

async function foreignClaimSettlement(params: {
  classification: DeviceClaimClassification;
  claim: DeviceClaim;
  device: DeviceInfo;
  observeDeviceBoot?: DeviceBootObservationService;
}): Promise<{ settles: true; tookOver?: TakenOverDeviceClaim } | { settles: false }> {
  if (deviceClaimOwnerCannotRelease(params.classification)) return { settles: true };
  const tookOver = await rebootedDeviceClaim(params);
  return tookOver ? { settles: true, tookOver } : { settles: false };
}

/**
 * Clears the claim only once its durable resources are settled, so a claim never disappears while
 * something owned by its session is still running.
 */
export async function settleVerifiedOrphanedClaim(
  claim: DeviceClaim,
  reconcile: DeviceClaimReconciler,
): Promise<DeviceClaimReconciliationResult> {
  const result = await reconcile(claim);
  if (result.status === 'retained') return result;
  try {
    fs.unlinkSync(resolveDeviceClaimPath(claim.deviceKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { status: 'reconciled' };
}

export function isClaimOwnedByThisDaemon(
  claim: DeviceClaim,
  stateDir: string,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return (
    claim.stateDir === stateDir &&
    ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, owner)
  );
}

/** An abandoned claim holds the device for nobody, so it grants no authority and fences no daemon. */
export function isAbandonedDeviceClaim(claim: DeviceClaim): boolean {
  return claim.abandonedAtMs !== undefined;
}

function isAbandonedClaimOfThisDaemon(
  claim: DeviceClaim,
  stateDir: string,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return isAbandonedDeviceClaim(claim) && isClaimOwnedByThisDaemon(claim, stateDir, owner);
}

function isCurrentClaimOwner(
  claim: DeviceClaim,
  params: { session: string; workspace: string; stateDir: string },
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return (
    claim.session === params.session &&
    claim.workspace === params.workspace &&
    isClaimOwnedByThisDaemon(claim, params.stateDir, owner)
  );
}

/** The one diagnostic that names who holds a device when an acquisition is refused. */
export function emitClaimConflict(
  deviceKey: string,
  existing: InspectedDeviceClaim,
  reconciliationReason?: string,
): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'device_claim_conflict',
    data: {
      deviceKey,
      classification: existing.classification,
      ...describeClaimOwner(existing),
      ...(reconciliationReason ? { reconciliationReason } : {}),
    },
  });
}

/** The owner projection of either claim kind, for diagnostics that name who holds the device. */
function describeClaimOwner(existing: InspectedDeviceClaim): Record<string, unknown> {
  if (existing.allocatorClaim) {
    return {
      ownerStateDir: existing.allocatorClaim.stateDir,
      allocatorInstanceId: existing.allocatorClaim.allocator.instanceId,
      identityIncarnationId: existing.allocatorClaim.allocator.identityIncarnationId,
    };
  }
  return { ownerSession: existing.claim?.session, ownerStateDir: existing.claim?.stateDir };
}

function emitClaimSupersede(deviceKey: string, abandoned: DeviceClaim): void {
  emitDiagnostic({
    level: 'info',
    phase: 'device_claim_abandoned_superseded',
    data: {
      deviceKey,
      abandonedSession: abandoned.session,
      abandonedAtMs: abandoned.abandonedAtMs,
    },
  });
}
