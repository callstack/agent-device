import fs from 'node:fs';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  deviceClaimOwnerCannotRelease,
  inspectDeviceClaimFile,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import {
  ownershipFromClaim,
  type DeviceClaim,
  type DeviceClaimSessionOwnership,
} from './device-claim-record.ts';
import {
  ownerIdentityMatches,
  type readCurrentOwnerIdentity,
} from '@agent-device/host-kit/process';

/**
 * What the claim file says before an acquisition writes its own record. `available` means the
 * caller may claim the device; `held` means the same session already owns the device and keeps its
 * ownership token.
 */
export type ExistingClaimResolution =
  | { status: 'available' }
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
 * settled exactly as `device release --stale` settles it — and a claim whose owner can still
 * release it holds the device.
 */
export async function resolveExistingClaim(params: {
  deviceKey: string;
  owner: ReturnType<typeof readCurrentOwnerIdentity>;
  session: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
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
    return { status: 'held', ownership: ownershipFromClaim(existing.claim) };
  }
  if (!existing.claim || !deviceClaimOwnerCannotRelease(existing.classification)) {
    emitClaimConflict(params.deviceKey, existing);
    return { status: 'conflict', conflict: existing };
  }
  const reconciliation = await settleVerifiedOrphanedClaim(
    existing.claim,
    params.reconcileOrphanedDeviceClaim,
  );
  if (reconciliation.status === 'retained') {
    emitClaimConflict(params.deviceKey, existing, reconciliation.reason);
    return { status: 'conflict', conflict: existing };
  }
  return { status: 'available' };
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
  params: Pick<Parameters<typeof resolveExistingClaim>[0], 'session' | 'workspace' | 'stateDir'>,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return (
    claim.session === params.session &&
    claim.workspace === params.workspace &&
    claim.stateDir === params.stateDir &&
    ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, owner)
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
