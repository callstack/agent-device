import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { acquireProcessLock } from '../utils/process-lock.ts';
import { ownerIdentityMatches, readCurrentOwnerIdentity } from '../utils/owner-identity.ts';
import { inspectDeviceClaimFile, type InspectedDeviceClaim } from './device-claim-inspection.ts';
import {
  canonicalLocalDeviceKey,
  resolveDeviceClaimPath,
  resolveDeviceClaimRoot,
} from './device-claim-paths.ts';

export { canonicalLocalDeviceKey } from './device-claim-paths.ts';

const DEVICE_CLAIM_SCHEMA_VERSION = 1;
const DEVICE_CLAIM_LOCK_TIMEOUT_MS = 30_000;

export type DeviceClaim = {
  schemaVersion: 1;
  deviceKey: string;
  device: {
    platform: ReturnType<typeof publicPlatformString>;
    id: string;
    name: string;
    kind: DeviceInfo['kind'];
    target?: DeviceInfo['target'];
    appleOs?: DeviceInfo['appleOs'];
    iosPhysicalDeviceBackend?: DeviceInfo['iosPhysicalDeviceBackend'];
  };
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

export function isLocalDeviceClaimTarget(
  meta:
    | {
        leaseProvider?: string;
        deviceKey?: string;
      }
    | undefined,
  providerOwned: boolean,
): boolean {
  return !providerOwned && !meta?.leaseProvider && !meta?.deviceKey;
}

export async function acquireDeviceClaim(params: {
  device: DeviceInfo;
  session: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedClaim?: DeviceClaimReconciler;
}): Promise<DeviceClaimAcquireResult> {
  const deviceKey = canonicalLocalDeviceKey(params.device);
  return await withDeviceClaimLock(deviceKey, async () => {
    const owner = readCurrentOwnerIdentity();
    const existingResult = await resolveExistingClaim({ deviceKey, owner, params });
    if (existingResult) return existingResult;
    const now = Date.now();
    const claim: DeviceClaim = {
      schemaVersion: DEVICE_CLAIM_SCHEMA_VERSION,
      deviceKey,
      device: {
        platform: publicPlatformString(params.device),
        id: params.device.id,
        name: params.device.name,
        kind: params.device.kind,
        ...(params.device.target ? { target: params.device.target } : {}),
        ...(params.device.appleOs ? { appleOs: params.device.appleOs } : {}),
        ...(params.device.iosPhysicalDeviceBackend
          ? { iosPhysicalDeviceBackend: params.device.iosPhysicalDeviceBackend }
          : {}),
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
  });
}

async function resolveExistingClaim(params: {
  deviceKey: string;
  owner: ReturnType<typeof readCurrentOwnerIdentity>;
  params: Parameters<typeof acquireDeviceClaim>[0];
}): Promise<DeviceClaimAcquireResult | undefined> {
  const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(params.deviceKey));
  if (!existing) return undefined;
  if (existing.claim && isCurrentClaimOwner(existing.claim, params.params, params.owner)) {
    return { status: 'acquired', ownership: ownershipFromClaim(existing.claim) };
  }
  if (
    existing.classification !== 'owner-process-dead' ||
    !existing.claim ||
    !params.params.reconcileOrphanedClaim
  ) {
    emitClaimConflict(params.deviceKey, existing);
    return { status: 'conflict', conflict: existing };
  }
  return await reconcileExistingOrphan(
    params.deviceKey,
    existing,
    existing.claim,
    params.params.reconcileOrphanedClaim,
  );
}

async function reconcileExistingOrphan(
  deviceKey: string,
  existing: InspectedDeviceClaim,
  claim: DeviceClaim,
  reconcile: DeviceClaimReconciler,
): Promise<DeviceClaimAcquireResult | undefined> {
  const reconciliation = await reconcile(claim);
  if (reconciliation.status === 'retained') {
    emitClaimConflict(deviceKey, existing, reconciliation.reason);
    return { status: 'conflict', conflict: existing };
  }
  if (unlinkMatchingOrphanedClaim(claim)) return undefined;
  const current = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey)) ?? existing;
  emitClaimConflict(deviceKey, current, 'owner-identity-changed');
  return { status: 'conflict', conflict: current };
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

export async function clearDeviceClaim(
  ownership: DeviceClaimSessionOwnership | undefined,
): Promise<void> {
  if (!ownership) return;
  await withDeviceClaimLock(ownership.deviceKey, async () => {
    const inspected = inspectDeviceClaimFile(resolveDeviceClaimPath(ownership.deviceKey));
    if (!inspected?.claim) return;
    const claim = inspected.claim;
    if (
      claim.ownerToken !== ownership.ownerToken ||
      !ownerIdentityMatches(
        { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        { pid: ownership.ownerPid, startTime: ownership.ownerStartTime },
      )
    ) {
      return;
    }
    try {
      fs.unlinkSync(resolveDeviceClaimPath(ownership.deviceKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
): Promise<{ reconciled: number; retained: number }> {
  const root = resolveDeviceClaimRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { reconciled: 0, retained: 0 };
  }
  let reconciled = 0;
  let retained = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(root, entry.name);
    const scanned = inspectDeviceClaimFile(filePath);
    if (scanned?.classification !== 'owner-process-dead' || !scanned.claim) continue;
    const { deviceKey, ownerToken } = scanned.claim;
    // A file whose name is not the hash of its own device key is not the file
    // the lock protects, so leave it rather than unlink something else.
    if (resolveDeviceClaimPath(deviceKey) !== filePath) continue;
    await withDeviceClaimLock(deviceKey, async () => {
      const current = inspectDeviceClaimFile(filePath);
      if (current?.classification !== 'owner-process-dead') return;
      if (current.claim?.ownerToken !== ownerToken) return;
      const result = await reconcile(current.claim);
      if (result.status === 'retained') {
        retained += 1;
        return;
      }
      if (unlinkMatchingOrphanedClaim(current.claim)) reconciled += 1;
      else retained += 1;
    });
  }
  return { reconciled, retained };
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

function unlinkMatchingOrphanedClaim(claim: DeviceClaim): boolean {
  const claimPath = resolveDeviceClaimPath(claim.deviceKey);
  const current = inspectDeviceClaimFile(claimPath);
  if (
    current?.classification !== 'owner-process-dead' ||
    current.claim?.ownerToken !== claim.ownerToken
  ) {
    return false;
  }
  try {
    fs.unlinkSync(claimPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return true;
  }
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
