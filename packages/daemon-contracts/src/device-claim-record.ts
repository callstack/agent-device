import {
  deviceFieldsFromPublicPlatform,
  decodeDeviceIdentity,
  isPublicPlatform,
  type DeviceIdentity,
} from '@agent-device/kernel/device';
import { isRecord } from '@agent-device/kernel/record';

import { canonicalLocalDeviceKey } from './device-claim-paths.ts';

/** Schema version of a process-owned claim record; v1/v2 records normalize to it on read. */
export const DEVICE_CLAIM_SCHEMA_VERSION = 3;

/**
 * What a claim's record states about who owns it. A current writer always states one.
 * `unstated` is what a record migrated from the released v1/v2 schemas decodes to, because those
 * schemas wrote a command-scoped claim and an open session *named* `transient:<command>`
 * identically; the session label is never re-read as the discriminant. A claim that states no kind
 * can hold and fence a device but can never cover a command.
 */
export type DeviceClaimOwnerKind = 'open-session' | 'transient-command' | 'unstated';

const DEVICE_CLAIM_OWNER_KINDS: readonly DeviceClaimOwnerKind[] = [
  'open-session',
  'transient-command',
  'unstated',
];

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
   * The persisted claim-kind discriminant (#3345). Coverage reads this and never the `session`
   * label: an open session may legitimately be named `transient:<command>`, and any printed
   * address can be pasted back into `--session`. It is stored rather than derived from the schema
   * version so a record renewed or abandoned after migration keeps saying the same thing.
   */
  claimOwnerKind: DeviceClaimOwnerKind;
  /** The command a `transient-command` claim is scoped to; present for exactly that kind. */
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
 * Every stored record normalizes to the current schema so that a renewal or an abandon can write a
 * decoded claim back without changing its shape. A v1/v2 record has no kind field, and the session
 * label cannot supply one, so it decodes as `unstated`: it keeps its full principal for clearing,
 * reconciliation, and stale settlement, and states no ownership kind.
 */
export function decodeStoredDeviceClaim(value: unknown): DeviceClaim | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion === DEVICE_CLAIM_SCHEMA_VERSION) return decodeCurrentClaim(value);
  if (value.schemaVersion === 2) return decodeClaimBody(value, 'unstated');
  if (value.schemaVersion === 1) return migrateLegacyClaim(value);
  return null;
}

/**
 * A current record states its kind, and the two kind fields have to agree: a command claim names
 * its command, any other kind names none. Anything else fails the record closed rather than
 * guessing which owner a session label suggests.
 */
function decodeCurrentClaim(raw: Record<string, unknown>): DeviceClaim | null {
  const { claimOwnerKind, transientCommand } = raw;
  if (!isKnownOwnerKind(claimOwnerKind)) return null;
  if (claimOwnerKind === 'transient-command') {
    if (!isNonEmptyString(transientCommand)) return null;
    const claim = decodeClaimBody(raw, claimOwnerKind);
    return claim ? { ...claim, transientCommand } : null;
  }
  if (transientCommand !== undefined) return null;
  return decodeClaimBody(raw, claimOwnerKind);
}

function isKnownOwnerKind(value: unknown): value is DeviceClaimOwnerKind {
  return (
    typeof value === 'string' && (DEVICE_CLAIM_OWNER_KINDS as readonly string[]).includes(value)
  );
}

function decodeClaimBody(
  raw: Record<string, unknown>,
  claimOwnerKind: DeviceClaimOwnerKind,
): DeviceClaim | null {
  if (!isRecord(raw.device) || !isNonEmptyString(raw.device.name)) return null;
  const identity = decodeDeviceIdentity(raw.device);
  return identity ? decodeClaimFields(raw, identity, raw.device.name, claimOwnerKind) : null;
}

/** Released schema-v1 claims differ only in device shape; they state no claim kind. */
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
  return identity ? decodeClaimFields(raw, identity, name, 'unstated') : null;
}

function decodeClaimFields(
  raw: Record<string, unknown>,
  identity: DeviceIdentity,
  name: string,
  claimOwnerKind: DeviceClaimOwnerKind,
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
    claimOwnerKind,
  };
}

/**
 * The claim `session` recorded for a command-scoped claim. Lives with the record so the label and
 * its inverse stay one owner; `claimOwnerKind` is what decides a kind, never this shape.
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
