import fs from 'node:fs';
import path from 'node:path';
import {
  deviceFieldsFromPublicPlatform,
  isPublicPlatform,
  matchesPlatformSelector,
  type DeviceIdentity,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { decodeDeviceIdentity } from '@agent-device/capture-kit';
import {
  classifyOwnerLivenessFromObservation,
  type OwnerLiveness,
  readHostProcessIdentityObservations,
} from '@agent-device/host-kit/process';

import { isSupersededDaemonOwner } from './daemon-registration.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimRoot } from './device-claim-paths.ts';
import type { DeviceClaim } from './device-claims.ts';

const DEVICE_CLAIM_SCHEMA_VERSION = 2;

export type DeviceClaimClassification = OwnerLiveness | 'inconsistent' | 'owner-daemon-superseded';

export type InspectedDeviceClaim = {
  fileName: string;
  deviceKey?: string;
  claim?: DeviceClaim;
  classification: DeviceClaimClassification;
  error?: string;
};

export type DeviceClaimSelectors = {
  platform?: PlatformSelector;
  device?: string;
  udid?: string;
  serial?: string;
};

export function inspectDeviceClaims(selectors: DeviceClaimSelectors): InspectedDeviceClaim[] {
  const root = resolveDeviceClaimRoot();
  const listed = readClaimEntries(root);
  if ('claims' in listed) return listed.claims;
  const parsed = listed.entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readDeviceClaimFile(path.join(root, entry.name)))
    .filter((entry): entry is InspectedDeviceClaim => entry !== null)
    .filter((entry) => matchesClaimSelectors(entry.claim, selectors));
  const observations = readHostProcessIdentityObservations(
    parsed.flatMap((entry) => (entry.claim ? [entry.claim.ownerPid] : [])),
  );
  return parsed.map((entry) =>
    classifyInspectedClaim(
      entry,
      entry.claim ? (observations.get(entry.claim.ownerPid) ?? null) : null,
    ),
  );
}

function readClaimEntries(
  root: string,
): { entries: fs.Dirent[] } | { claims: InspectedDeviceClaim[] } {
  try {
    return { entries: fs.readdirSync(root, { withFileTypes: true }) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { claims: [] };
    return {
      claims: [{ fileName: path.basename(root), classification: 'unknown', error: String(error) }],
    };
  }
}

function matchesClaimSelectors(
  claim: DeviceClaim | undefined,
  selectors: DeviceClaimSelectors,
): boolean {
  if (!claim) return true;
  return [
    matchesClaimId(claim, selectors.udid ?? selectors.serial),
    matchesClaimDevice(claim, selectors.device),
    matchesClaimPlatform(claim, selectors.platform),
  ].every(Boolean);
}

function matchesClaimId(claim: DeviceClaim, expectedId: string | undefined): boolean {
  return !expectedId || claim.device.id === expectedId;
}

function matchesClaimDevice(claim: DeviceClaim, device: string | undefined): boolean {
  return !device || claim.device.name === device || claim.device.id === device;
}

function matchesClaimPlatform(claim: DeviceClaim, platform: PlatformSelector | undefined): boolean {
  return matchesPlatformSelector(
    { platform: claim.device.family, appleOs: claim.device.appleOs },
    platform,
  );
}

export function inspectDeviceClaimFile(filePath: string): InspectedDeviceClaim | null {
  const entry = readDeviceClaimFile(filePath);
  if (!entry?.claim) return entry;
  const observations = readHostProcessIdentityObservations([entry.claim.ownerPid]);
  return classifyInspectedClaim(entry, observations.get(entry.claim.ownerPid) ?? null);
}

function readDeviceClaimFile(filePath: string): InspectedDeviceClaim | null {
  const fileName = path.basename(filePath);
  try {
    return inspectClaimContents(fileName, fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return {
      fileName,
      classification: 'unknown',
      error: String(error),
    };
  }
}

function inspectClaimContents(fileName: string, contents: string): InspectedDeviceClaim {
  try {
    const claim = normalizeClaim(JSON.parse(contents) as unknown);
    if (!claim) return { fileName, classification: 'inconsistent' };
    return {
      fileName,
      deviceKey: claim.deviceKey,
      claim,
      classification: 'unknown',
    };
  } catch (error) {
    return { fileName, classification: 'inconsistent', error: String(error) };
  }
}

function classifyInspectedClaim(
  entry: InspectedDeviceClaim,
  observation: Parameters<typeof classifyOwnerLivenessFromObservation>[1],
): InspectedDeviceClaim {
  const claim = entry.claim;
  if (!claim) return entry;
  const owner = { pid: claim.ownerPid, startTime: claim.ownerStartTime };
  const liveness = classifyOwnerLivenessFromObservation(
    { owner, stateDir: claim.stateDir },
    observation,
  );
  // A live owner holds a device exclusively only while it can still be asked to
  // release it. #2031: a replaced daemon keeps running and keeps its claim, but
  // clients reach the successor published for its state dir instead, so the
  // claim names a session no `session list` reports and no `close` can reach.
  const superseded =
    liveness === 'live' && isSupersededDaemonOwner({ ...owner, stateDir: claim.stateDir });
  return { ...entry, classification: superseded ? 'owner-daemon-superseded' : liveness };
}

/** Claims hidden by the default status view and exposed through `device status --stale`. */
export function deviceClaimRequiresStaleInspection(
  classification: DeviceClaimClassification,
): boolean {
  switch (classification) {
    case 'owner-process-dead':
    case 'owner-process-reused':
    case 'owner-state-dir-gone':
    case 'owner-daemon-superseded':
      return true;
    case 'live':
    case 'unknown':
    case 'inconsistent':
      return false;
  }
}

/**
 * Claims whose recorded owner can no longer release them, and which
 * reconciliation may therefore settle once exact-owner resource recovery
 * reaches a terminal state. Both members are proofs about the owner, never
 * about the resource: `owner-process-dead` is a process that exited,
 * `owner-daemon-superseded` one that still runs but no longer serves the state
 * dir its claim was taken in.
 */
export function deviceClaimOwnerCannotRelease(classification: DeviceClaimClassification): boolean {
  switch (classification) {
    case 'owner-process-dead':
    case 'owner-daemon-superseded':
      return true;
    case 'live':
    case 'owner-process-reused':
    case 'owner-state-dir-gone':
    case 'unknown':
    case 'inconsistent':
      return false;
  }
}

function normalizeClaim(value: unknown): DeviceClaim | null {
  if (!isClaimObject(value)) return null;
  if (value.schemaVersion === DEVICE_CLAIM_SCHEMA_VERSION) return decodeCurrentClaim(value);
  if (value.schemaVersion === 1) return migrateLegacyClaim(value);
  return null;
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
): Pick<DeviceClaim, 'createdAtMs' | 'updatedAtMs'> | null {
  const { createdAtMs, updatedAtMs } = raw;
  if (!isFiniteNumber(createdAtMs) || !isFiniteNumber(updatedAtMs)) return null;
  return { createdAtMs, updatedAtMs };
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
