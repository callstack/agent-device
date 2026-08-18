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
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform';
import { acquireProcessLock } from '../utils/process-lock.ts';
import { ownerIdentityMatches, readCurrentOwnerIdentity } from '../utils/owner-identity.ts';
import { inspectDeviceClaimFile, type InspectedDeviceClaim } from './device-claim-inspection.ts';
import {
  canonicalLocalDeviceKey,
  resolveDeviceClaimPath,
  resolveDeviceClaimRoot,
} from './device-claim-paths.ts';

const DEVICE_CLAIM_SCHEMA_VERSION = 2;
const DEVICE_CLAIM_LOCK_TIMEOUT_MS = 30_000;

export type DeviceClaim = {
  schemaVersion: 2;
  deviceKey: string;
  device: DeviceIdentity & { name: string };
  session: string;
  workspace: string;
  stateDir: string;
  ownerPid: number;
  ownerStartTime: string | null;
  ownerToken: string;
  createdAtMs: number;
  updatedAtMs: number;
};

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

/** Claim policy follows the admitted runtime owner, never request metadata. */
export function isLocalDeviceClaimTarget(owner: RuntimeOwnerRef): boolean {
  return owner.kind === 'local-family';
}

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
 * already held by this daemon process covers the command instead of colliding
 * with it — the claim file itself, not the in-memory session table, is the
 * authority for that, so a claim acquired earlier in the same request (`open`'s,
 * for instance) can never lock the daemon out of its own device.
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
  writeClaim(claim);
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

function deviceClaimIdentity(device: DeviceInfo): DeviceIdentity {
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
  if (existing.claim && isCurrentClaimOwner(existing.claim, params, params.owner)) {
    return { status: 'acquired', ownership: ownershipFromClaim(existing.claim) };
  }
  if (existing.classification !== 'owner-process-dead' || !existing.claim) {
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
    if (
      !claim ||
      claim.ownerToken !== ownership.ownerToken ||
      !ownerIdentityMatches(
        { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        { pid: ownership.ownerPid, startTime: ownership.ownerStartTime },
      )
    ) {
      return 'ownership-changed';
    }
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
 * Reconciles claims whose owning process is provably gone and clears only
 * claims whose attributable durable resources reached a safe terminal state.
 *
 * Claims are released on session close and daemon shutdown, but a process that
 * dies abruptly leaves its file behind for proof-oriented recovery.
 *
 * The liveness check is repeated under the per-device lock immediately before
 * reconciliation: claim paths are derived from the device key, so a concurrent
 * daemon can replace the same dead claim while this scan is still running.
 * Acting on the first read could clear the successor.
 *
 * Deliberately narrower than the CLI's stale filter: `owner-state-dir-gone`
 * describes a LIVE process whose state dir vanished, and deleting that claim
 * could hand its device to a second session.
 */
export async function reconcileOrphanedDeviceClaims(
  reconcile: DeviceClaimReconciler,
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
    if (scanned?.classification !== 'owner-process-dead' || !scanned.claim) continue;
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
        current?.classification !== 'owner-process-dead' ||
        current.claim?.ownerToken !== ownerToken
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

function emitClaimConflict(
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
      ownerSession: existing.claim?.session,
      ownerStateDir: existing.claim?.stateDir,
      ...(reconciliationReason ? { reconciliationReason } : {}),
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

function writeClaim(claim: DeviceClaim): void {
  const claimPath = resolveDeviceClaimPath(claim.deviceKey);
  fs.mkdirSync(path.dirname(claimPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${claimPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(claim)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, claimPath);
}

async function withDeviceClaimLock<T>(deviceKey: string, task: () => Promise<T>): Promise<T> {
  const owner = readCurrentOwnerIdentity();
  const release = await acquireProcessLock({
    lockDirPath: `${resolveDeviceClaimPath(deviceKey)}.lock`,
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    timeoutMs: DEVICE_CLAIM_LOCK_TIMEOUT_MS,
    description: `device claim for ${deviceKey}`,
  });
  try {
    return await task();
  } finally {
    await release();
  }
}

function ownershipFromClaim(claim: DeviceClaim): DeviceClaimSessionOwnership {
  return {
    deviceKey: claim.deviceKey,
    ownerToken: claim.ownerToken,
    ownerPid: claim.ownerPid,
    ownerStartTime: claim.ownerStartTime,
  };
}
