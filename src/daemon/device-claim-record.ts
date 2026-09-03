import {
  deviceFieldsFromPublicPlatform,
  isPublicPlatform,
  type DeviceIdentity,
} from '@agent-device/kernel/device';
import { decodeDeviceIdentity } from '@agent-device/capture-kit';
import {
  managedLocalRuntimeOwner,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';

import { canonicalLocalDeviceKey } from './device-claim-paths.ts';

/** Schema version of a process-owned claim record; v1 records migrate to it on read. */
export const DEVICE_CLAIM_SCHEMA_VERSION = 2;

/**
 * Schema version of an allocator-held claim record. A separate version rather than a discriminant
 * inside the v2 record: a process-owned file never gains an allocator principal, and a daemon too
 * old to know this kind reads the file as inconsistent instead of as a claim it could clear.
 */
export const ALLOCATOR_HELD_CLAIM_SCHEMA_VERSION = 3;

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
 * ADR 0021 §4: a claim held for the pool lifetime of one allocator-managed identity. Its principal
 * is an INSTALLATION — the state dir, the allocator instance, and the identity incarnation — and
 * never a process, so it carries no `ownerPid`/`ownerStartTime`/`ownerToken`/`session`/`workspace`
 * and cannot be abandoned. Sessions and commands execute under it rather than replacing it.
 */
export type AllocatorHeldDeviceClaim = {
  schemaVersion: 3;
  kind: 'allocator';
  deviceKey: string;
  device: DeviceIdentity & { name: string };
  stateDir: string;
  allocator: AllocatorClaimIdentity;
  createdAtMs: number;
  updatedAtMs: number;
};

/** The allocator half of an allocator-held claim's principal. */
export type AllocatorClaimIdentity = { instanceId: string; identityIncarnationId: string };

/**
 * Anything the claim store can hold for one device. Named for the store, not for the claim: the
 * shutdown ledger's `DeviceClaimRecord` is a different thing (one row of what teardown released).
 */
export type StoredDeviceClaim = DeviceClaim | AllocatorHeldDeviceClaim;

export function isAllocatorHeldDeviceClaim(
  record: StoredDeviceClaim,
): record is AllocatorHeldDeviceClaim {
  return record.schemaVersion === ALLOCATOR_HELD_CLAIM_SCHEMA_VERSION;
}

/**
 * The managed owner an allocator-held claim admits. Derived from the recorded allocator instance
 * rather than stored beside it, so an owner that disagrees with the claim's principal cannot exist.
 */
export function allocatorHeldClaimOwner(
  claim: AllocatorHeldDeviceClaim,
): Extract<RuntimeOwnerRef, { kind: 'managed-local' }> {
  return managedLocalRuntimeOwner(claim.allocator.instanceId);
}

export function decodeStoredDeviceClaim(value: unknown): StoredDeviceClaim | null {
  if (!isClaimObject(value)) return null;
  if (value.schemaVersion === ALLOCATOR_HELD_CLAIM_SCHEMA_VERSION) {
    return decodeAllocatorHeldClaim(value);
  }
  if (value.schemaVersion === DEVICE_CLAIM_SCHEMA_VERSION) return decodeCurrentClaim(value);
  if (value.schemaVersion === 1) return migrateLegacyClaim(value);
  return null;
}

/**
 * Whether raw claim-file contents declare the allocator-held schema version, independent of
 * whether the rest of the record decodes. A record that answers true here but that
 * {@link decodeStoredDeviceClaim} still rejects is not provably a non-allocator record, so a
 * reader that must fail closed on an allocator-held claim cannot treat it as absent.
 */
export function looksLikeAllocatorHeldClaim(value: unknown): boolean {
  return isClaimObject(value) && value.schemaVersion === ALLOCATOR_HELD_CLAIM_SCHEMA_VERSION;
}

/** Fields that would make an allocator-held record answer a process principal. */
const PROCESS_PRINCIPAL_FIELDS = [
  'ownerPid',
  'ownerStartTime',
  'ownerToken',
  'session',
  'workspace',
  'abandonedAtMs',
] as const;

function decodeAllocatorHeldClaim(raw: Record<string, unknown>): AllocatorHeldDeviceClaim | null {
  // A process principal on an allocator record would hand it back to ownership matching, the
  // startup sweep and `--stale` release. A record carrying one is not a record we can read.
  if (raw.kind !== 'allocator' || carriesProcessPrincipal(raw)) return null;
  const body = decodeAllocatorHeldBody(raw);
  return body && { schemaVersion: ALLOCATOR_HELD_CLAIM_SCHEMA_VERSION, kind: 'allocator', ...body };
}

function carriesProcessPrincipal(raw: Record<string, unknown>): boolean {
  return PROCESS_PRINCIPAL_FIELDS.some((field) => raw[field] !== undefined);
}

function decodeAllocatorHeldBody(
  raw: Record<string, unknown>,
): Omit<AllocatorHeldDeviceClaim, 'schemaVersion' | 'kind'> | null {
  if (!isClaimObject(raw.device) || !isNonEmptyString(raw.device.name)) return null;
  const name = raw.device.name;
  const identity = decodeDeviceIdentity(raw.device);
  const deviceKey = readNonEmptyString(raw.deviceKey);
  const stateDir = readNonEmptyString(raw.stateDir);
  const allocator = decodeAllocatorIdentity(raw.allocator);
  const timestamps = decodeClaimTimestamps(raw);
  if (!identity || !deviceKey || !stateDir || !allocator || !timestamps) return null;
  if (deviceKey !== canonicalLocalDeviceKey(identity)) return null;
  return {
    deviceKey,
    device: { ...identity, name },
    stateDir,
    allocator,
    createdAtMs: timestamps.createdAtMs,
    updatedAtMs: timestamps.updatedAtMs,
  };
}

function decodeAllocatorIdentity(value: unknown): AllocatorClaimIdentity | null {
  if (!isClaimObject(value)) return null;
  const instanceId = readAllocatorId(value.instanceId);
  const identityIncarnationId = readAllocatorId(value.identityIncarnationId);
  return instanceId && identityIncarnationId ? { instanceId, identityIncarnationId } : null;
}

/**
 * Allocator ids are compared verbatim against the managed binding fence and keyed verbatim into the
 * managed owner, so a padded id would fence one request while keying another owner.
 */
function readAllocatorId(value: unknown): string | null {
  return isNonEmptyString(value) && value === value.trim() ? value : null;
}

function isClaimObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeCurrentClaim(raw: Record<string, unknown>): DeviceClaim | null {
  if (!isClaimObject(raw.device) || !isNonEmptyString(raw.device.name)) return null;
  const identity = decodeDeviceIdentity(raw.device);
  return identity ? buildDecodedClaim(raw, identity, raw.device.name) : null;
}

/** Released schema-v1 advisory claims are normalized into the canonical v2 model on read. */
function migrateLegacyClaim(raw: Record<string, unknown>): DeviceClaim | null {
  if (!isClaimObject(raw.device)) return null;
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
