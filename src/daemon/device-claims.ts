import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  deviceIdentity,
  isApplePlatform,
  resolveDeviceAppleOs,
  type DeviceIdentity,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { ownerIdentityMatches, readCurrentOwnerIdentity } from '@agent-device/host-kit/process';

import {
  deviceClaimOwnerCannotRelease,
  inspectDeviceClaimFile,
  inspectDeviceClaims,
  type DeviceClaimClassification,
  type DeviceClaimSelectors,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import {
  canonicalLocalDeviceKey,
  resolveDeviceClaimPath,
  resolveDeviceClaimRoot,
} from './device-claim-paths.ts';
import {
  DEVICE_CLAIM_SCHEMA_VERSION,
  type AllocatorClaimIdentity,
  type DeviceClaim,
} from './device-claim-record.ts';
import { withDeviceClaimLock, writeDeviceClaim } from './device-claim-store.ts';

export type DeviceClaimReconciliationResult =
  | { status: 'reconciled' }
  | { status: 'retained'; reason: string };

export type DeviceClaimReconciler = (
  claim: DeviceClaim,
) => Promise<DeviceClaimReconciliationResult>;

export type DeviceClaimSessionOwnership = {
  deviceKey: string;
  ownerToken: string;
  ownerPid: number;
  ownerStartTime: string | null;
};

export type DeviceClaimAcquireResult =
  | { status: 'acquired'; ownership: DeviceClaimSessionOwnership }
  | { status: 'conflict'; conflict: InspectedDeviceClaim };

/**
 * A `transient-exclusive` command may find the device already claimed by a
 * session of the very daemon executing it. That session claim already carries
 * the exclusion the command needs, so the command adds none of its own.
 */
export type TransientDeviceClaimResult =
  | DeviceClaimAcquireResult
  | { status: 'covered-by-owned-claim' };

/**
 * The claim `session` recorded for a command-scoped claim. Claim records carry
 * no separate kind discriminant, so the session field is what tells `device
 * status` that the owner is a command in flight rather than an open session.
 */
function transientDeviceClaimSession(command: string): string {
  return `transient:${command}`;
}

export async function acquireDeviceClaim(params: {
  device: DeviceInfo;
  session: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<DeviceClaimAcquireResult> {
  const identity = deviceClaimIdentity(params.device);
  const deviceKey = canonicalLocalDeviceKey(identity);
  return await withDeviceClaimLock(
    deviceKey,
    async () => await claimHeldDevice({ ...params, deviceKey, identity }),
  );
}

/**
 * #1320 `transient-exclusive`: exclusive ownership for the duration of one
 * sessionless device mutation. Identical to a session claim except that a claim
 * this daemon still holds covers the command instead of colliding with it — the
 * claim file itself, not the in-memory session table, is the authority for that,
 * so a claim acquired earlier in the same request (`open`'s, for instance) can
 * never lock the daemon out of its own device. An abandoned claim holds nothing,
 * so it is superseded into this command's own transient claim instead.
 */
export async function acquireTransientDeviceClaim(params: {
  device: DeviceInfo;
  command: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<TransientDeviceClaimResult> {
  const identity = deviceClaimIdentity(params.device);
  const deviceKey = canonicalLocalDeviceKey(identity);
  return await withDeviceClaimLock(deviceKey, async () => {
    const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey));
    if (
      existing?.claim &&
      !isAbandonedDeviceClaim(existing.claim) &&
      isClaimOwnedByThisDaemon(existing.claim, params.stateDir, readCurrentOwnerIdentity())
    ) {
      return { status: 'covered-by-owned-claim' };
    }
    return await claimHeldDevice({
      device: params.device,
      deviceKey,
      identity,
      session: transientDeviceClaimSession(params.command),
      workspace: params.workspace,
      stateDir: params.stateDir,
      reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
    });
  });
}

/** Acquisition body shared by session and transient claims; the caller holds the claim lock. */
async function claimHeldDevice(params: {
  device: DeviceInfo;
  deviceKey: string;
  identity: DeviceIdentity;
  session: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<DeviceClaimAcquireResult> {
  const { deviceKey, identity } = params;
  const owner = readCurrentOwnerIdentity();
  const existingResult = await resolveExistingClaim({
    deviceKey,
    owner,
    session: params.session,
    workspace: params.workspace,
    stateDir: params.stateDir,
    reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
  });
  if (existingResult.status !== 'available') return existingResult;
  const now = Date.now();
  const claim: DeviceClaim = {
    schemaVersion: DEVICE_CLAIM_SCHEMA_VERSION,
    deviceKey,
    device: {
      ...identity,
      name: params.device.name,
    },
    session: params.session,
    workspace: params.workspace,
    stateDir: params.stateDir,
    ownerPid: owner.pid,
    ownerStartTime: owner.startTime,
    ownerToken: crypto.randomUUID(),
    createdAtMs: now,
    updatedAtMs: now,
  };
  writeDeviceClaim(claim);
  return { status: 'acquired', ownership: ownershipFromClaim(claim) };
}

function isClaimOwnedByThisDaemon(
  claim: DeviceClaim,
  stateDir: string,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return (
    claim.stateDir === stateDir &&
    ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, owner)
  );
}

function isAbandonedDeviceClaim(claim: DeviceClaim): boolean {
  return claim.abandonedAtMs !== undefined;
}

/**
 * Does this process hold the claim for exactly this device right now? The
 * Apple runner's device-claim arbitration probe (#1320 retained-runner rule):
 * claim authority lets a daemon stop and replace a warm runner whose owner no
 * longer holds the device. Matching is by the canonical local device key —
 * family, Apple OS, and id — never by bare id, so a same-id claim from another
 * platform family grants nothing. Ownership is proven by process identity
 * alone — one process serves one daemon — and an abandoned claim holds the
 * device for nobody, so it grants no authority either.
 */
export function processOwnsActiveDeviceClaim(device: DeviceInfo): boolean {
  const deviceKey = canonicalLocalDeviceKey(deviceClaimIdentity(device));
  const claim = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey))?.claim;
  return (
    claim !== undefined &&
    claim.deviceKey === deviceKey &&
    !isAbandonedDeviceClaim(claim) &&
    ownerIdentityMatches(
      { pid: claim.ownerPid, startTime: claim.ownerStartTime },
      readCurrentOwnerIdentity(),
    )
  );
}

function isAbandonedClaimOfThisDaemon(
  claim: DeviceClaim,
  stateDir: string,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return isAbandonedDeviceClaim(claim) && isClaimOwnedByThisDaemon(claim, stateDir, owner);
}

/** The canonical claim-facing identity of a local device: family, Apple OS, and id. */
export function deviceClaimIdentity(device: DeviceInfo): DeviceIdentity {
  return deviceIdentity({
    ...device,
    ...(isApplePlatform(device.platform) ? { appleOs: resolveDeviceAppleOs(device) } : {}),
  });
}

async function resolveExistingClaim(params: {
  deviceKey: string;
  owner: ReturnType<typeof readCurrentOwnerIdentity>;
  session: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<DeviceClaimAcquireResult | { status: 'available' }> {
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
    return { status: 'acquired', ownership: ownershipFromClaim(existing.claim) };
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

function isCurrentClaimOwner(
  claim: DeviceClaim,
  params: Pick<Parameters<typeof acquireDeviceClaim>[0], 'session' | 'workspace' | 'stateDir'>,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return (
    claim.session === params.session &&
    claim.workspace === params.workspace &&
    claim.stateDir === params.stateDir &&
    ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, owner)
  );
}

/**
 * One claim's outcome from `device release --stale`. `released` cleared the
 * claim after resource reconciliation; `retained` has positive stale proof but
 * unsettled resources; `refused` lacks positive proof that the owner cannot
 * release (live, uncertain, corrupt, or PID-reused owners all fail closed);
 * `changed` lost a race with a concurrent owner transition.
 */
export type DeviceClaimStaleReleaseOutcome = {
  fileName: string;
  classification: DeviceClaimClassification;
  status: 'released' | 'retained' | 'refused' | 'changed';
  reason?: string;
  deviceKey?: string;
  device?: DeviceClaim['device'];
  session?: string;
  workspace?: string;
  stateDir?: string;
  /** Present only for an allocator-held claim, which this command always refuses. */
  allocator?: AllocatorClaimIdentity;
};

/**
 * #1320 `device release --stale`: settle and clear every matching claim whose
 * recorded owner provably cannot release it, through the same reconciliation
 * transaction `open` and daemon startup use — resources first, claim last.
 * Everything without that positive proof is reported and left untouched.
 */
export async function releaseProvenStaleDeviceClaims(params: {
  selectors: DeviceClaimSelectors;
  reconcile: DeviceClaimReconciler;
}): Promise<DeviceClaimStaleReleaseOutcome[]> {
  const outcomes: DeviceClaimStaleReleaseOutcome[] = [];
  for (const entry of inspectDeviceClaims(params.selectors)) {
    outcomes.push(await releaseInspectedStaleClaim(entry, params.reconcile));
  }
  return outcomes;
}

async function releaseInspectedStaleClaim(
  entry: InspectedDeviceClaim,
  reconcile: DeviceClaimReconciler,
): Promise<DeviceClaimStaleReleaseOutcome> {
  const claim = entry.claim;
  const base = {
    fileName: entry.fileName,
    classification: entry.classification,
    ...(entry.deviceKey ? { deviceKey: entry.deviceKey } : {}),
    ...(claim
      ? {
          device: claim.device,
          session: claim.session,
          workspace: claim.workspace,
          stateDir: claim.stateDir,
        }
      : {}),
    ...(entry.allocatorClaim
      ? {
          device: entry.allocatorClaim.device,
          stateDir: entry.allocatorClaim.stateDir,
          allocator: entry.allocatorClaim.allocator,
        }
      : {}),
  };
  if (!claim || !deviceClaimOwnerCannotRelease(entry.classification)) {
    return { ...base, status: 'refused', reason: staleReleaseRefusalReason(entry.classification) };
  }
  // A file whose name is not the hash of its own device key is not the file
  // the claim lock protects; releasing through it could unlink something else.
  if (
    resolveDeviceClaimPath(claim.deviceKey) !== path.join(resolveDeviceClaimRoot(), entry.fileName)
  ) {
    return { ...base, status: 'refused', reason: 'claim-file-name-mismatch' };
  }
  const { deviceKey, ownerToken } = claim;
  return await withDeviceClaimLock(deviceKey, async () => {
    const current = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey));
    if (
      !current?.claim ||
      current.claim.ownerToken !== ownerToken ||
      !deviceClaimOwnerCannotRelease(current.classification)
    ) {
      return { ...base, status: 'changed' as const, reason: 'claim-changed-during-release' };
    }
    const result = await settleVerifiedOrphanedClaim(current.claim, reconcile);
    if (result.status === 'retained') {
      return { ...base, status: 'retained' as const, reason: result.reason };
    }
    emitDiagnostic({
      level: 'info',
      phase: 'device_claim_stale_released',
      data: { deviceKey, ownerSession: claim.session, ownerStateDir: claim.stateDir },
    });
    return { ...base, status: 'released' as const };
  });
}

/**
 * A lookup rather than a switch: the branch count a switch this size carries reads as complexity
 * fallow's health gate flags, while a `Record` stays a flat table TypeScript still checks for
 * exhaustiveness (a classification dropped from `DeviceClaimClassification` fails to compile here
 * exactly as it would a missing `case`).
 */
const STALE_RELEASE_REFUSAL_REASONS: Readonly<Record<DeviceClaimClassification, string>> =
  Object.freeze({
    live: 'live-owner',
    'owner-process-reused': 'owner-pid-reused',
    'owner-state-dir-gone': 'owner-process-still-running',
    unknown: 'owner-liveness-unknown',
    inconsistent: 'claim-record-inconsistent',
    'allocator-inconsistent': 'allocator-claim-record-inconsistent',
    'allocator-held': 'allocator-held-owner',
    'owner-process-dead': 'claim-record-unreadable',
    'owner-daemon-superseded': 'claim-record-unreadable',
  });

function staleReleaseRefusalReason(classification: DeviceClaimClassification): string {
  return STALE_RELEASE_REFUSAL_REASONS[classification];
}

/**
 * What releasing a claim actually did. Resolving is not the same as releasing:
 * clearing deliberately leaves a claim it does not own in place, so a caller
 * that reports ownership must read this rather than the absence of a throw.
 *
 *  - `deleted`          — the claim this ownership acquired was removed.
 *  - `absent`           — no claim remains for the device; nothing to remove.
 *  - `ownership-changed`— a claim remains, but it is not the one we acquired
 *                         (a successor owner, or a record we cannot attribute).
 */
export type DeviceClaimClearOutcome = 'deleted' | 'absent' | 'ownership-changed';

export async function clearDeviceClaim(
  ownership: DeviceClaimSessionOwnership | undefined,
): Promise<DeviceClaimClearOutcome> {
  if (!ownership) return 'absent';
  return await withDeviceClaimLock(ownership.deviceKey, async () => {
    const claimPath = resolveDeviceClaimPath(ownership.deviceKey);
    const inspected = inspectDeviceClaimFile(claimPath);
    if (!inspected) return 'absent';
    const claim = inspected.claim;
    if (!claim || !claimMatchesOwnership(claim, ownership)) return 'ownership-changed';
    try {
      fs.unlinkSync(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return 'absent';
    }
    return 'deleted';
  });
}

/**
 * What abandoning a claim did, in the terms {@link DeviceClaimClearOutcome} uses:
 *
 *  - `abandoned`        — the claim we acquired now holds the device for nobody.
 *  - `absent`           — no claim remains for the device; nothing to mark.
 *  - `ownership-changed`— a claim remains, but it is not the one we acquired.
 */
export type DeviceClaimAbandonOutcome = 'abandoned' | 'absent' | 'ownership-changed';

/**
 * Keeps the device fenced against every other owner while recording that this claim holds it for
 * nobody. Only the daemon that abandoned it may take it back.
 */
export async function abandonDeviceClaim(
  ownership: DeviceClaimSessionOwnership | undefined,
): Promise<DeviceClaimAbandonOutcome> {
  if (!ownership) return 'absent';
  return await withDeviceClaimLock(ownership.deviceKey, async () => {
    const inspected = inspectDeviceClaimFile(resolveDeviceClaimPath(ownership.deviceKey));
    if (!inspected) return 'absent';
    const claim = inspected.claim;
    if (!claim || !claimMatchesOwnership(claim, ownership)) return 'ownership-changed';
    const now = Date.now();
    writeDeviceClaim({ ...claim, abandonedAtMs: now, updatedAtMs: now });
    return 'abandoned';
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

/**
 * Reconciles claims whose owner can no longer release them and clears only
 * claims whose attributable durable resources reached a safe terminal state.
 *
 * Claims are released on session close and daemon shutdown, but a process that
 * dies abruptly leaves its file behind for proof-oriented recovery, and #2031 a
 * daemon that was replaced while still running leaves one no client can reach.
 *
 * The owner check is repeated under the per-device lock immediately before
 * reconciliation: claim paths are derived from the device key, so a concurrent
 * daemon can replace the same orphaned claim while this scan is still running.
 * Acting on the first read could clear the successor.
 *
 * Deliberately narrower than the CLI's stale filter: `owner-state-dir-gone`
 * describes a LIVE process whose state dir vanished, and deleting that claim
 * could hand its device to a second session. Narrower again for owners that are
 * still running, which this sweep settles only inside `daemonStateDir` — see
 * {@link sweepMayReconcile}.
 */
export async function reconcileOrphanedDeviceClaims(
  reconcile: DeviceClaimReconciler,
  daemonStateDir: string,
): Promise<{ examined: number; reconciled: number; retained: number; changed: number }> {
  const root = resolveDeviceClaimRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { examined: 0, reconciled: 0, retained: 0, changed: 0 };
  }
  let examined = 0;
  let reconciled = 0;
  let retained = 0;
  let changed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(root, entry.name);
    const scanned = inspectDeviceClaimFile(filePath);
    if (
      !scanned?.claim ||
      !sweepMayReconcile(scanned.classification, scanned.claim.stateDir, daemonStateDir)
    ) {
      continue;
    }
    examined += 1;
    const { deviceKey, ownerToken } = scanned.claim;
    // A file whose name is not the hash of its own device key is not the file
    // the lock protects, so leave it rather than unlink something else.
    if (resolveDeviceClaimPath(deviceKey) !== filePath) {
      retained += 1;
      continue;
    }
    await withDeviceClaimLock(deviceKey, async () => {
      const current = inspectDeviceClaimFile(filePath);
      if (
        !current?.claim ||
        !sweepMayReconcile(current.classification, current.claim.stateDir, daemonStateDir) ||
        current.claim.ownerToken !== ownerToken
      ) {
        changed += 1;
        return;
      }
      const result = await settleVerifiedOrphanedClaim(current.claim, reconcile);
      if (result.status === 'retained') {
        retained += 1;
        return;
      }
      reconciled += 1;
    });
  }
  return { examined, reconciled, retained, changed };
}

/**
 * What the unattended startup sweep may settle. A proven-dead owner is
 * reconciled wherever the host-global store holds it, but a superseded owner is
 * still running: finalizing the durable resources attributed to it is only this
 * daemon's business inside the state dir it now serves. A superseded owner
 * elsewhere is settled by {@link acquireDeviceClaim} instead, at the one device
 * a caller actually asked for.
 */
function sweepMayReconcile(
  classification: DeviceClaimClassification,
  ownerStateDir: string,
  daemonStateDir: string,
): boolean {
  if (!deviceClaimOwnerCannotRelease(classification)) return false;
  if (classification !== 'owner-daemon-superseded') return true;
  return path.resolve(ownerStateDir) === path.resolve(daemonStateDir);
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

async function settleVerifiedOrphanedClaim(
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

function ownershipFromClaim(claim: DeviceClaim): DeviceClaimSessionOwnership {
  return {
    deviceKey: claim.deviceKey,
    ownerToken: claim.ownerToken,
    ownerPid: claim.ownerPid,
    ownerStartTime: claim.ownerStartTime,
  };
}
