import {
  deviceFieldsFromPublicPlatform,
  isPublicPlatform,
  type DeviceIdentity,
} from '@agent-device/kernel/device';
import { decodeDeviceIdentity } from '@agent-device/capture-kit';
import { isRecord } from '@agent-device/kernel/record';

import { canonicalLocalDeviceKey } from './device-claim-paths.ts';

/** Schema version of a process-owned claim record; v1 records migrate to it on read. */
export const DEVICE_CLAIM_SCHEMA_VERSION = 2;

/**
 * A claim owned by one process: the session or the sessionless command that took it. Its principal
 * is `ownerPid`/`ownerStartTime`/`ownerToken`, which is what every clearing surface matches on.
 */
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
  /** Set by `abandonDeviceClaim`; absent while the claim still holds the device for its owner. */
  abandonedAtMs?: number;
};

/**
 * The ownership token a claim grants its holder: everything a clearing surface must match to let
 * that holder release, abandon, or keep fencing the claim, and nothing else.
 */
export type DeviceClaimSessionOwnership = {
  deviceKey: string;
  ownerToken: string;
  ownerPid: number;
  ownerStartTime: string | null;
};

/** The ownership token carried by a persisted claim record. */
export function ownershipFromClaim(claim: DeviceClaim): DeviceClaimSessionOwnership {
  return {
    deviceKey: claim.deviceKey,
    ownerToken: claim.ownerToken,
    ownerPid: claim.ownerPid,
    ownerStartTime: claim.ownerStartTime,
  };
}

export function decodeStoredDeviceClaim(value: unknown): DeviceClaim | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion === DEVICE_CLAIM_SCHEMA_VERSION) return decodeCurrentClaim(value);
  if (value.schemaVersion === 1) return migrateLegacyClaim(value);
  return null;
}

function decodeCurrentClaim(raw: Record<string, unknown>): DeviceClaim | null {
  if (!isRecord(raw.device) || !isNonEmptyString(raw.device.name)) return null;
  const identity = decodeDeviceIdentity(raw.device);
  return identity ? buildDecodedClaim(raw, identity, raw.device.name) : null;
}

/** Released schema-v1 advisory claims are normalized into the canonical v2 model on read. */
function migrateLegacyClaim(raw: Record<string, unknown>): DeviceClaim | null {
  if (!isRecord(raw.device)) return null;
  const legacy = raw.device;
  const name = legacy.name;
  if (!isNonEmptyString(name)) return null;
  if (!isPublicPlatform(legacy.platform)) return null;
  const fields = deviceFieldsFromPublicPlatform(legacy.platform);
  const identity = decodeDeviceIdentity({
    id: legacy.id,
    family: fields.platform,
    kind: legacy.kind,
    target: legacy.target,
    ...(legacy.appleOs === undefined
      ? fields.platform === 'apple'
        ? { appleOs: legacy.platform === 'macos' ? 'macos' : 'ios' }
        : {}
      : { appleOs: legacy.appleOs }),
    ...(legacy.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: legacy.iosPhysicalDeviceBackend }),
  });
  return identity ? buildDecodedClaim(raw, identity, name) : null;
}

function buildDecodedClaim(
  raw: Record<string, unknown>,
  identity: DeviceIdentity,
  name: string,
): DeviceClaim | null {
  const location = decodeClaimLocation(raw);
  const owner = decodeClaimOwner(raw);
  const timestamps = decodeClaimTimestamps(raw);
  if (!location || !owner || !timestamps) return null;
  if (location.deviceKey !== canonicalLocalDeviceKey(identity)) return null;
  return {
    schemaVersion: DEVICE_CLAIM_SCHEMA_VERSION,
    ...location,
    device: { ...identity, name },
    ...owner,
    ...timestamps,
  };
}

function decodeClaimLocation(
  raw: Record<string, unknown>,
): Pick<DeviceClaim, 'deviceKey' | 'session' | 'workspace' | 'stateDir'> | null {
  const deviceKey = readNonEmptyString(raw.deviceKey);
  const session = readNonEmptyString(raw.session);
  const workspace = readNonEmptyString(raw.workspace);
  const stateDir = readNonEmptyString(raw.stateDir);
  if (!deviceKey || !session || !workspace || !stateDir) return null;
  return { deviceKey, session, workspace, stateDir };
}

function decodeClaimOwner(
  raw: Record<string, unknown>,
): Pick<DeviceClaim, 'ownerPid' | 'ownerStartTime' | 'ownerToken'> | null {
  const { ownerPid, ownerStartTime } = raw;
  const ownerToken = readNonEmptyString(raw.ownerToken);
  if (!isPositiveInteger(ownerPid) || !ownerToken) return null;
  if (ownerStartTime !== null && !isNonEmptyString(ownerStartTime)) return null;
  return { ownerPid, ownerStartTime, ownerToken };
}

function decodeClaimTimestamps(
  raw: Record<string, unknown>,
): Pick<DeviceClaim, 'createdAtMs' | 'updatedAtMs' | 'abandonedAtMs'> | null {
  const { createdAtMs, updatedAtMs, abandonedAtMs } = raw;
  if (!isFiniteNumber(createdAtMs) || !isFiniteNumber(updatedAtMs)) return null;
  if (abandonedAtMs !== undefined && !isFiniteNumber(abandonedAtMs)) return null;
  return {
    createdAtMs,
    updatedAtMs,
    ...(isFiniteNumber(abandonedAtMs) ? { abandonedAtMs } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readNonEmptyString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
