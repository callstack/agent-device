import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  deviceIdentity,
  isApplePlatform,
  canHostAppDevices,
  hostDeviceIdPrefix,
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
import { resolveDeviceClaimRoot } from '@agent-device/host-kit/file';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import {
  DEVICE_CLAIM_SCHEMA_VERSION,
  ownershipFromClaim,
  transientDeviceClaimSession,
  type DeviceClaim,
  type DeviceClaimSessionOwnership,
} from './device-claim-record.ts';
import {
  isAbandonedDeviceClaim,
  isAbandonedClaimOfThisDaemon,
  isClaimOwnedByThisDaemon,
  resolveExistingClaim,
  settleVerifiedOrphanedClaim,
  type DeviceClaimAcquirerKind,
  type DeviceClaimReconciler,
  type InspectedClaimSettlement,
} from './device-claim-settlement.ts';
import { withDeviceClaimLock, writeDeviceClaim } from './device-claim-store.ts';

export { canonicalLocalDeviceKey } from './device-claim-paths.ts';
export {
  deviceClaimOwnerCannotRelease,
  deviceClaimRequiresStaleInspection,
  inspectDeviceClaims,
} from './device-claim-inspection.ts';
export type {
  DeviceClaimClassification,
  DeviceClaimSelectors,
  InspectedDeviceClaim,
} from './device-claim-inspection.ts';
export type { DeviceClaim } from './device-claim-record.ts';
export type { TakenOverDeviceClaim } from './device-claim-reboot.ts';
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
 * A `transient-exclusive` command may find the device already claimed by this daemon.
 * Only an open session's own claim, taken from the request's workspace, carries the exclusion
 * the command needs, so that one adds none of its own. Any other claim — another session's, or
 * any command-scoped claim this daemon holds in flight — is a foreign live owner (#3345):
 * sessions of one daemon are separate owners of a device.
 */
export type TransientDeviceClaimResult =
  | DeviceClaimAcquireResult
  | { status: 'covered-by-owned-claim' };

export async function acquireDeviceClaim(params: {
  device: DeviceInfo;
  session: string;
  workspace: string;
  stateDir: string;
  env: EnvMap;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
  /**
   * Asks the device whether it rebooted after a foreign claim was taken, which is the only proof
   * that outlives a live owner. Callers that have no answer to give omit it and keep the conflict.
   */
  observeDeviceBoot?: DeviceBootObservationService;
}): Promise<DeviceClaimAcquireResult> {
  const identity = deviceClaimIdentity(params.device);
  const deviceKey = canonicalLocalDeviceKey(identity);
  return await withAcquisitionLocks(
    { ...params, claimOwnerKind: 'open-session' },
    deviceKey,
    async () => await claimHeldDevice({ ...params, deviceKey, identity }),
  );
}

/**
 * Runs an acquisition under its claim lock. An app device acquisition first takes its host key's
 * lock, so a host claim and an app device claim are never written past each other (ADR 0035): a
 * live host claim refuses it, and a host claim it supersedes is removed once its own is written.
 */
async function withAcquisitionLocks<Result extends TransientDeviceClaimResult>(
  params: {
    device: DeviceInfo;
    session: string;
    workspace: string;
    stateDir: string;
    env: EnvMap;
    claimOwnerKind: DeviceClaimAcquirerKind;
    transientCommand?: string;
    reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
    observeDeviceBoot?: DeviceBootObservationService;
  },
  deviceKey: string,
  acquire: () => Promise<Result>,
): Promise<Result | DeviceClaimAcquireResult> {
  const hostDeviceId = params.device.hostApp?.hostDeviceId;
  if (hostDeviceId === undefined) return await withDeviceClaimLock(deviceKey, params.env, acquire);
  const host: DeviceInfo = { ...params.device, id: hostDeviceId, hostApp: undefined };
  const hostKey = canonicalLocalDeviceKey(deviceClaimIdentity(host));
  return await withDeviceClaimLock(hostKey, params.env, async () => {
    const hostClaim = await resolveExistingClaim({
      ...params,
      device: host,
      deviceKey: hostKey,
      owner: readCurrentOwnerIdentity(),
    });
    if (hostClaim.status === 'conflict') return hostClaim;
    if (hostClaim.status === 'held') {
      const held = inspectDeviceClaimFile(resolveDeviceClaimPath(hostKey, params.env));
      if (held) return { status: 'conflict', conflict: held };
    }
    const acquired = await withDeviceClaimLock(deviceKey, params.env, acquire);
    if (acquired.status !== 'acquired') return acquired;
    removeSupersededDeviceClaim(hostKey, params.env);
    const tookOver =
      acquired.tookOver ?? (hostClaim.status === 'available' ? hostClaim.tookOver : undefined);
    return tookOver ? { ...acquired, tookOver } : acquired;
  });
}

function removeSupersededDeviceClaim(deviceKey: string, env: EnvMap): void {
  try {
    fs.unlinkSync(resolveDeviceClaimPath(deviceKey, env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * #1320 `transient-exclusive`: exclusive ownership for the duration of one
 * sessionless device mutation. Identical to a session claim except that the claim
 * of the session this command runs in covers the command instead of colliding with
 * it — the claim file itself, not the in-memory session table, is the authority for
 * that, so a claim acquired earlier in the same request (`open`'s, for instance) can
 * never lock the session out of its own device. A claim this daemon holds for a
 * *different* session collides, because #3345 established that one daemon serving
 * several worktrees does not make those worktrees one owner. An abandoned claim holds
 * nothing, so it is superseded into this command's own transient claim instead.
 *
 * Coverage proves ownership the way {@link acquireDeviceClaim} does: the covered claim
 * must have been recorded by this request's workspace, not merely carry the same session
 * string. Session addresses are copyable — `device status` prints them and refusal
 * details carry them — so without that, a caller in another workspace could paste the
 * owner's address into `--session` and pass as the owner.
 */
export async function acquireTransientDeviceClaim(params: {
  device: DeviceInfo;
  command: string;
  /**
   * The session this command runs in, i.e. the session whose own claim covers it.
   * Unlike {@link acquireDeviceClaim}, this is not the session the record gets: a
   * command-scoped claim stays attributable to the command that took it.
   */
  coveredBySession: string;
  /**
   * Whether the live claim under {@link coveredBySession} was taken by this request's
   * workspace rather than merely recorded under the same session string. Session
   * addresses are copyable (#3345), so session equality alone lets a caller that
   * pasted another workspace's address act as that workspace's owner. Only an
   * `open-session` claim is ever a candidate: the record's `claimOwnerKind`, not its
   * label, decides whether it can cover anything.
   */
  coveredClaimIsOwnedByRequest: (claim: DeviceClaim) => boolean;
  workspace: string;
  stateDir: string;
  env: EnvMap;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<TransientDeviceClaimResult> {
  const identity = deviceClaimIdentity(params.device);
  const deviceKey = canonicalLocalDeviceKey(identity);
  const session = transientDeviceClaimSession(params.command);
  const lockParams = {
    ...params,
    session,
    claimOwnerKind: 'transient-command' as const,
    transientCommand: params.command,
  };
  return await withAcquisitionLocks(lockParams, deviceKey, async () => {
    const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey, params.env));
    if (
      existing?.claim &&
      !isAbandonedDeviceClaim(existing.claim) &&
      isClaimOwnedByThisDaemon(existing.claim, params.stateDir, readCurrentOwnerIdentity())
    ) {
      const claimKind = existing.claim.claimOwnerKind;
      if (
        claimKind === 'open-session' &&
        existing.claim.session === params.coveredBySession &&
        params.coveredClaimIsOwnedByRequest(existing.claim)
      ) {
        return { status: 'covered-by-owned-claim' };
      }
      // Only a record that states its kind can take part in a kind decision. A migrated record
      // states none, and `isClaimOwnedByThisDaemon` matches pid plus start time — which two
      // processes can share once a start time is unreadable — so coverage has to refuse rather
      // than assume an old record was not some other owner's command claim (#3345). A live claim
      // of any other kind — another session's or a command's, including one labeled exactly like
      // this command — refuses here, because renewing it would hand this request a token it
      // never took.
      if (claimKind !== 'open-session') {
        return { status: 'conflict', conflict: existing };
      }
    }
    return await claimHeldDevice({
      device: params.device,
      deviceKey,
      identity,
      session,
      transientCommand: params.command,
      workspace: params.workspace,
      stateDir: params.stateDir,
      env: params.env,
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
  /** The command a `transient-exclusive` acquisition scopes its claim to; absent for sessions. */
  transientCommand?: string;
  workspace: string;
  stateDir: string;
  env: EnvMap;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
  observeDeviceBoot?: DeviceBootObservationService;
}): Promise<DeviceClaimAcquireResult> {
  const { deviceKey, identity } = params;
  const owner = readCurrentOwnerIdentity();
  const claimOwnerKind: DeviceClaimAcquirerKind =
    params.transientCommand === undefined ? 'open-session' : 'transient-command';
  let supersededAppClaims: string[] = [];
  if (!params.device.hostApp && canHostAppDevices(params.device)) {
    const apps = await settleAppDeviceClaims(
      canonicalLocalDeviceKey({ ...identity, id: hostDeviceIdPrefix(identity.id) }),
      params,
    );
    if (apps.conflict) return { status: 'conflict', conflict: apps.conflict };
    supersededAppClaims = apps.abandoned;
  }
  const existing = await resolveExistingClaim({
    ...params,
    owner,
    claimOwnerKind,
  });
  if (existing.status === 'conflict') return existing;
  if (existing.status === 'held') {
    await removeSupersededAppClaims(supersededAppClaims, params.env);
    return { status: 'acquired', ownership: existing.ownership };
  }
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
    claimOwnerKind,
    ...(params.transientCommand === undefined ? {} : { transientCommand: params.transientCommand }),
  };
  writeDeviceClaim(claim, params.env);
  await removeSupersededAppClaims(supersededAppClaims, params.env);
  return {
    status: 'acquired',
    ownership: ownershipFromClaim(claim),
    ...(existing.tookOver ? { tookOver: existing.tookOver } : {}),
  };
}

/**
 * A host acquisition settles the claims of its app devices first: reconciled when their owner is
 * dead or this daemon abandoned them, a conflict otherwise. An unreadable claim file refuses too,
 * because nothing proves it is not one of them.
 */
async function settleAppDeviceClaims(
  appDeviceKeyPrefix: string,
  params: { stateDir: string; env: EnvMap; reconcileOrphanedDeviceClaim: DeviceClaimReconciler },
): Promise<{ abandoned: string[]; conflict?: InspectedDeviceClaim }> {
  const abandoned: string[] = [];
  for (const entry of inspectDeviceClaims({}, params.env)) {
    const scanned = entry.claim;
    if (!scanned) return { conflict: entry, abandoned: [] };
    if (!scanned.deviceKey.startsWith(appDeviceKeyPrefix)) continue;
    const conflict = await withDeviceClaimLock(scanned.deviceKey, params.env, async () => {
      const current = inspectDeviceClaimFile(resolveDeviceClaimPath(scanned.deviceKey, params.env));
      if (!current) return undefined;
      const settlement = inspectOverlappingAppClaim(
        current,
        params.stateDir,
        readCurrentOwnerIdentity(),
      );
      if (settlement.status === 'available') {
        if (settlement.superseded) abandoned.push(settlement.superseded.deviceKey);
        return undefined;
      }
      if (settlement.status === 'conflict') return settlement.conflict;
      const settled = await settleVerifiedOrphanedClaim(
        settlement.claim,
        params.reconcileOrphanedDeviceClaim,
        params.env,
      );
      return settled.status === 'retained' ? current : undefined;
    });
    if (conflict) return { conflict, abandoned: [] };
  }
  return { abandoned };
}

function inspectOverlappingAppClaim(
  current: InspectedDeviceClaim,
  stateDir: string,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): Exclude<InspectedClaimSettlement, { status: 'held' }> {
  if (!current.claim) return { status: 'conflict', conflict: current };
  if (isAbandonedClaimOfThisDaemon(current.claim, stateDir, owner)) {
    return { status: 'available', superseded: current.claim };
  }
  if (!deviceClaimOwnerCannotRelease(current.classification)) {
    return { status: 'conflict', conflict: current };
  }
  return { status: 'reconcile', claim: current.claim, conflict: current };
}

async function removeSupersededAppClaims(deviceKeys: string[], env: EnvMap): Promise<void> {
  for (const deviceKey of deviceKeys) {
    await withDeviceClaimLock(deviceKey, env, async () =>
      removeSupersededDeviceClaim(deviceKey, env),
    );
  }
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
export function processOwnsActiveDeviceClaim(device: DeviceInfo, env: EnvMap): boolean {
  const deviceKey = canonicalLocalDeviceKey(deviceClaimIdentity(device));
  const claim = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey, env))?.claim;
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
  env: EnvMap;
}): Promise<DeviceClaimStaleReleaseOutcome[]> {
  const outcomes: DeviceClaimStaleReleaseOutcome[] = [];
  for (const entry of inspectDeviceClaims(params.selectors, params.env)) {
    outcomes.push(await releaseInspectedStaleClaim(entry, params.reconcile, params.env));
  }
  return outcomes;
}

async function releaseInspectedStaleClaim(
  entry: InspectedDeviceClaim,
  reconcile: DeviceClaimReconciler,
  env: EnvMap,
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
  };
  if (!claim || !deviceClaimOwnerCannotRelease(entry.classification)) {
    return { ...base, status: 'refused', reason: staleReleaseRefusalReason(entry.classification) };
  }
  // A file whose name is not the hash of its own device key is not the file
  // the claim lock protects; releasing through it could unlink something else.
  if (
    resolveDeviceClaimPath(claim.deviceKey, env) !==
    path.join(resolveDeviceClaimRoot(env), entry.fileName)
  ) {
    return { ...base, status: 'refused', reason: 'claim-file-name-mismatch' };
  }
  const { deviceKey, ownerToken } = claim;
  return await withDeviceClaimLock(deviceKey, env, async () => {
    const current = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey, env));
    if (
      !current?.claim ||
      current.claim.ownerToken !== ownerToken ||
      !deviceClaimOwnerCannotRelease(current.classification)
    ) {
      return { ...base, status: 'changed' as const, reason: 'claim-changed-during-release' };
    }
    const result = await settleVerifiedOrphanedClaim(current.claim, reconcile, env);
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
 *                         unreadable or undecodable. This says nothing about who owns the
 *                         device and is NOT evidence we released anything, so a
 *                         caller that is about to forget this claim must hold it
 *                         back and try again rather than read it as superseded.
 */
export type DeviceClaimClearOutcome = 'deleted' | 'absent' | 'ownership-changed' | 'unattributable';

export async function clearDeviceClaim(
  ownership: DeviceClaimSessionOwnership | undefined,
  env: EnvMap,
): Promise<DeviceClaimClearOutcome> {
  if (!ownership) return 'absent';
  return await writeOwnedDeviceClaim(
    ownership,
    env,
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
  env: EnvMap,
): Promise<DeviceClaimAbandonOutcome> {
  if (!ownership) return 'absent';
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim) => {
      const now = Date.now();
      writeDeviceClaim({ ...claim, abandonedAtMs: now, updatedAtMs: now }, env);
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
  env: EnvMap,
): Promise<DeviceClaimRenewal> {
  if (!ownership) return { status: 'lost', conflict: undefined };
  return await writeOwnedDeviceClaim(
    ownership,
    env,
    (claim) => {
      writeDeviceClaim({ ...claim, updatedAtMs: Date.now() }, env);
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
  env: EnvMap,
): Promise<{ examined: number; reconciled: number; retained: number; changed: number }> {
  const root = resolveDeviceClaimRoot(env);
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
    if (resolveDeviceClaimPath(deviceKey, env) !== filePath) {
      retained += 1;
      continue;
    }
    await withDeviceClaimLock(deviceKey, env, async () => {
      const current = inspectDeviceClaimFile(filePath);
      if (
        !current?.claim ||
        !sweepMayReconcile(current.classification, current.claim.stateDir, daemonStateDir) ||
        current.claim.ownerToken !== ownerToken
      ) {
        changed += 1;
        return;
      }
      const result = await settleVerifiedOrphanedClaim(current.claim, reconcile, env);
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
