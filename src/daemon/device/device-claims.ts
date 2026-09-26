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
import type { DeviceBootObservationService } from '@agent-device/contracts/device-boot';
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
import type { TakenOverDeviceClaim } from './device-claim-reboot.ts';
import {
  canonicalLocalDeviceKey,
  resolveDeviceClaimPath,
  resolveDeviceClaimRoot,
} from './device-claim-paths.ts';
import {
  DEVICE_CLAIM_SCHEMA_VERSION,
  ownershipFromClaim,
  type AllocatorClaimIdentity,
  type DeviceClaim,
  type DeviceClaimSessionOwnership,
} from './device-claim-record.ts';
import {
  isAbandonedDeviceClaim,
  isClaimOwnedByThisDaemon,
  resolveExistingClaim,
  settleVerifiedOrphanedClaim,
  type DeviceClaimReconciler,
} from './device-claim-settlement.ts';
import { withDeviceClaimLock, writeDeviceClaim } from './device-claim-store.ts';

export type { DeviceClaimReconciler } from './device-claim-settlement.ts';
export type { DeviceClaimSessionOwnership } from './device-claim-record.ts';

export type DeviceClaimAcquireResult =
  | {
      status: 'acquired';
      ownership: DeviceClaimSessionOwnership;
      /** The stale foreign claim this acquisition replaced, when there was one. */
      tookOver?: TakenOverDeviceClaim;
    }
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
  /**
   * Asks the device whether it rebooted after a foreign claim was taken, which is the only proof
   * that outlives a live owner. Callers that have no answer to give omit it and keep the conflict.
   */
  observeDeviceBoot?: DeviceBootObservationService;
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
  observeDeviceBoot?: DeviceBootObservationService;
}): Promise<DeviceClaimAcquireResult> {
  const { deviceKey, identity } = params;
  const owner = readCurrentOwnerIdentity();
  const existing = await resolveExistingClaim({
    ...params,
    owner,
  });
  if (existing.status === 'conflict') return existing;
  if (existing.status === 'held') return { status: 'acquired', ownership: existing.ownership };
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
  return {
    status: 'acquired',
    ownership: ownershipFromClaim(claim),
    ...(existing.tookOver ? { tookOver: existing.tookOver } : {}),
  };
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

/** The canonical claim-facing identity of a local device: family, Apple OS, and id. */
export function deviceClaimIdentity(device: DeviceInfo): DeviceIdentity {
  return deviceIdentity({
    ...device,
    ...(isApplePlatform(device.platform) ? { appleOs: resolveDeviceAppleOs(device) } : {}),
  });
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
 *  - `ownership-changed`— a decodable claim remains and it is not the one we
 *                         acquired, so a successor owns the device now.
 *  - `unattributable`   — a record remains that yields no attributable claim:
 *                         unreadable, undecodable, or held by an allocator
 *                         principal. This says nothing about who owns the
 *                         device and is NOT evidence we released anything, so a
 *                         caller that is about to forget this claim must hold it
 *                         back and try again rather than read it as superseded.
 */
export type DeviceClaimClearOutcome = 'deleted' | 'absent' | 'ownership-changed' | 'unattributable';

export async function clearDeviceClaim(
  ownership: DeviceClaimSessionOwnership | undefined,
): Promise<DeviceClaimClearOutcome> {
  if (!ownership) return 'absent';
  return await writeOwnedDeviceClaim(
    ownership,
    (_claim, claimPath) => {
      try {
        fs.unlinkSync(claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return 'absent';
      }
      return 'deleted';
    },
    (conflict) => {
      if (!conflict) return 'absent';
      // `claim` is optional by type precisely to keep a reader from matching against a record that
      // never decoded into a process-owned claim. Present means a successor's record; absent means
      // the file told us nothing we can attribute to either side.
      return conflict.claim ? 'ownership-changed' : 'unattributable';
    },
  );
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
  return await writeOwnedDeviceClaim(
    ownership,
    (claim) => {
      const now = Date.now();
      writeDeviceClaim({ ...claim, abandonedAtMs: now, updatedAtMs: now });
      return 'abandoned';
    },
    (conflict) => (conflict ? 'ownership-changed' : 'absent'),
  );
}

/**
 * What a renewal found when the claim was no longer the one this session holds: the record that
 * took the device, or nothing at all when the claim is gone.
 */
export type DeviceClaimRenewal =
  | { status: 'renewed' }
  | { status: 'lost'; conflict: InspectedDeviceClaim | undefined };

/**
 * Stamps the instant this ownership was last seen holding the device, which is the instant a later
 * device boot has to postdate before it can invalidate the claim. An existing session that reopened
 * its app vouched for the device again; without this stamp its first claim timestamp would let a
 * foreign `open` read a reboot the owner already came back from as a device nobody owns.
 *
 * Renewal is the owner's check that it still holds the device, so a caller that is about to touch
 * the device on this session's behalf has to treat a lost renewal as losing the device.
 */
export async function renewDeviceClaim(
  ownership: DeviceClaimSessionOwnership | undefined,
): Promise<DeviceClaimRenewal> {
  if (!ownership) return { status: 'lost', conflict: undefined };
  return await writeOwnedDeviceClaim(
    ownership,
    (claim) => {
      writeDeviceClaim({ ...claim, updatedAtMs: Date.now() });
      return { status: 'renewed' } as const;
    },
    (conflict) => ({ status: 'lost' as const, conflict }),
  );
}

/**
 * Runs one claim write under the claim lock, for the owner that acquired it, and reports the record
 * that took the device when it is no longer the one that ownership took.
 */
async function writeOwnedDeviceClaim<O, L>(
  ownership: DeviceClaimSessionOwnership,
  act: (claim: DeviceClaim, claimPath: string) => O,
  lost: (conflict: InspectedDeviceClaim | undefined) => L,
): Promise<O | L> {
  return await withDeviceClaimLock(ownership.deviceKey, async () => {
    const claimPath = resolveDeviceClaimPath(ownership.deviceKey);
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
