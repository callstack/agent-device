import {
  deviceFieldsFromPublicPlatform,
  decodeDeviceIdentity,
  isPublicPlatform,
  type DeviceIdentity,
} from '@agent-device/kernel/device';
import { isRecord } from '@agent-device/kernel/record';

import { canonicalLocalDeviceKey } from './device-claim-paths.ts';

/** Schema version of a process-owned claim record; v1/v2 records migrate to it on read. */
export const DEVICE_CLAIM_SCHEMA_VERSION = 3;

/**
 * A claim owned by one process: the session or the sessionless command that took it. Its principal
 * is `ownerPid`/`ownerStartTime`/`ownerToken`, which is what every clearing surface matches on.
 */
export type DeviceClaim = {
  schemaVersion: 3;
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
  /**
   * Set when a `transient-exclusive` command took the claim: the command it is scoped to. This is
   * the claim-kind discriminant (#3345) — a command-scoped claim is never an open session's claim,
   * even when its `session` label reads `transient:<command>` and a caller copies that label into
   * `--session`. Absent means an open session owns it, including every legacy record: a v1/v2
   * record cannot prove which it was, and no kind decision is ever taken on one (see
   * {@link decodeStoredDeviceClaim}).
   */
  transientCommand?: string;
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

/**
 * Legacy (v1/v2) records decode kindless — as open-session claims — because they cannot state a
 * kind: released v1/v2 recorded a command-scoped claim and an open session *named*
 * `transient:<command>` identically, so the label is no proof of kind. Decoding kindless is safe
 * by construction, not by guess: every consumer of a claim's kind first requires
 * `isClaimOwnedByThisDaemon` (same stateDir, pid, and process start time), and a current process
 * writes only v3 records whose kind is stored — a legacy record can only be one this process
 * could not have written, so its owner identity is proven not to match. Recovery for a legacy
 * record needs nothing special: the recording process still holds its token, and any other owner
 * is settled or conflicted by the principal-based paths, none of which reads a kind.
 */
export function decodeStoredDeviceClaim(value: unknown): DeviceClaim | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion === DEVICE_CLAIM_SCHEMA_VERSION) return decodeCurrentClaim(value);
  if (value.schemaVersion === 2) return decodeClaimBody(value);
  if (value.schemaVersion === 1) return migrateLegacyClaim(value);
  return null;
}

/**
 * The current schema states its claim kind explicitly: a missing `transientCommand` is an
 * open-session claim, never a pattern re-derived from the session label.
 */
function decodeCurrentClaim(raw: Record<string, unknown>): DeviceClaim | null {
  const claim = decodeClaimBody(raw);
  if (!claim) return null;
  if (raw.transientCommand === undefined) return claim;
  return isNonEmptyString(raw.transientCommand)
    ? { ...claim, transientCommand: raw.transientCommand }
    : null;
}

type DecodedClaimBody = Omit<DeviceClaim, 'transientCommand' | 'abandonedAtMs'> & {
  schemaVersion: 3;
  abandonedAtMs?: number;
};

function decodeClaimBody(raw: Record<string, unknown>): DecodedClaimBody | null {
  if (!isRecord(raw.device) || !isNonEmptyString(raw.device.name)) return null;
  const identity = decodeDeviceIdentity(raw.device);
  return identity ? decodeClaimFields(raw, identity, raw.device.name) : null;
}

/** Released schema-v1 advisory claims are normalized into the canonical v3 model on read. */
function migrateLegacyClaim(raw: Record<string, unknown>): DecodedClaimBody | null {
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
  return identity ? decodeClaimFields(raw, identity, name) : null;
}

function decodeClaimFields(
  raw: Record<string, unknown>,
  identity: DeviceIdentity,
  name: string,
): DecodedClaimBody | null {
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

/**
 * The claim `session` recorded for a command-scoped claim. Lives with the record so the label and
 * its inverse stay one owner; admission decides on {@link DeviceClaim.transientCommand}, never on
 * this shape.
 */
export function transientDeviceClaimSession(command: string): string {
  return `${TRANSIENT_CLAIM_LABEL_PREFIX}${command}`;
}

const TRANSIENT_CLAIM_LABEL_PREFIX = 'transient:';

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
