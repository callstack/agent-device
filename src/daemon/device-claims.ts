import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publicPlatformString, type DeviceInfo } from '../kernel/device.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { acquireProcessLock } from '../utils/process-lock.ts';
import { ownerIdentityMatches, readCurrentOwnerIdentity } from '../utils/owner-identity.ts';
import { inspectDeviceClaimFile, type InspectedDeviceClaim } from './device-claim-inspection.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';

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

export type DeviceClaimSessionOwnership = {
  deviceKey: string;
  ownerToken: string;
  ownerPid: number;
  ownerStartTime: string | null;
};

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

export function canonicalLocalDeviceKey(device: DeviceInfo): string {
  const appleOs = device.appleOs ?? 'none';
  return `local:${device.platform}:${appleOs}:${device.id}`;
}

export async function acquireAdvisoryDeviceClaim(params: {
  device: DeviceInfo;
  session: string;
  workspace: string;
  stateDir: string;
}): Promise<{ ownership?: DeviceClaimSessionOwnership; conflict?: InspectedDeviceClaim }> {
  const deviceKey = canonicalLocalDeviceKey(params.device);
  return await withDeviceClaimLock(deviceKey, async () => {
    const owner = readCurrentOwnerIdentity();
    const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey));
    if (existing) {
      if (existing.claim && isCurrentClaimOwner(existing.claim, params, owner)) {
        return { ownership: ownershipFromClaim(existing.claim) };
      }
      emitDiagnostic({
        level: 'warn',
        phase: 'device_claim_advisory_conflict',
        data: {
          deviceKey,
          classification: existing.classification,
          ownerSession: existing.claim?.session,
          ownerStateDir: existing.claim?.stateDir,
        },
      });
      return { conflict: existing };
    }
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
    return { ownership: ownershipFromClaim(claim) };
  });
}

function isCurrentClaimOwner(
  claim: DeviceClaim,
  params: Pick<
    Parameters<typeof acquireAdvisoryDeviceClaim>[0],
    'session' | 'workspace' | 'stateDir'
  >,
  owner: ReturnType<typeof readCurrentOwnerIdentity>,
): boolean {
  return (
    claim.session === params.session &&
    claim.workspace === params.workspace &&
    claim.stateDir === params.stateDir &&
    ownerIdentityMatches({ pid: claim.ownerPid, startTime: claim.ownerStartTime }, owner)
  );
}

export async function clearAdvisoryDeviceClaim(
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
