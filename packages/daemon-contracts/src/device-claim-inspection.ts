import fs from 'node:fs';
import path from 'node:path';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  devicesOverlap,
  matchesPlatformSelector,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import {
  classifyOwnerLivenessFromObservation,
  type HostProcessIdentityObservation,
  type OwnerLiveness,
  readHostProcessIdentityObservations,
  readHostProcessIdentityObservationsAsync,
} from '@agent-device/host-kit/process';

import { isSupersededDaemonOwner } from './daemon-registration.ts';
import { resolveDeviceClaimRoot } from '@agent-device/host-kit/file';
import { decodeStoredDeviceClaim, type DeviceClaim } from './device-claim-record.ts';

export type DeviceClaimClassification = OwnerLiveness | 'inconsistent' | 'owner-daemon-superseded';

/** One inspected claim file. */
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

type OwnerObservations = ReadonlyMap<number, HostProcessIdentityObservation>;

/**
 * Every matching claim, judged from one process-table snapshot. This one blocks for that snapshot,
 * which suits a one-shot CLI; a daemon path uses {@link inspectDeviceClaimsAsync}.
 */
export function inspectDeviceClaims(
  selectors: DeviceClaimSelectors,
  env: EnvMap,
): InspectedDeviceClaim[] {
  const listed = readMatchingClaimFiles(selectors, env);
  if ('claims' in listed) return listed.claims;
  return classifyInspectedClaims(
    listed.parsed,
    readHostProcessIdentityObservations(claimOwnerPids(listed.parsed)),
  );
}

/** {@link inspectDeviceClaims} with the snapshot taken off the event loop. */
export async function inspectDeviceClaimsAsync(
  selectors: DeviceClaimSelectors,
  env: EnvMap,
): Promise<InspectedDeviceClaim[]> {
  const listed = readMatchingClaimFiles(selectors, env);
  if ('claims' in listed) return listed.claims;
  return classifyInspectedClaims(
    listed.parsed,
    await readHostProcessIdentityObservationsAsync(claimOwnerPids(listed.parsed)),
  );
}

function readMatchingClaimFiles(
  selectors: DeviceClaimSelectors,
  env: EnvMap,
): { parsed: InspectedDeviceClaim[] } | { claims: InspectedDeviceClaim[] } {
  const root = resolveDeviceClaimRoot(env);
  const listed = readClaimEntries(root);
  if ('claims' in listed) return listed;
  const parsed = listed.entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readDeviceClaimEntry(path.join(root, entry.name)))
    .filter((entry): entry is InspectedDeviceClaim => entry !== null)
    .filter((entry) => matchesClaimSelectors(entry.claim, selectors));
  return { parsed };
}

function claimOwnerPids(entries: readonly InspectedDeviceClaim[]): number[] {
  return entries.flatMap((entry) => (entry.claim ? [entry.claim.ownerPid] : []));
}

function classifyInspectedClaims(
  entries: readonly InspectedDeviceClaim[],
  observations: OwnerObservations,
): InspectedDeviceClaim[] {
  return entries.map((entry) =>
    entry.claim
      ? classifyInspectedClaim(entry, observations.get(entry.claim.ownerPid) ?? null)
      : entry,
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

/** A host selector also matches its app devices' claims, and an app device selector its host's. */
function matchesClaimId(claim: DeviceClaim, expectedId: string | undefined): boolean {
  return !expectedId || devicesOverlap(claim.device.id, expectedId);
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

/** One claim file, judged off the event loop. */
export async function inspectDeviceClaimFile(
  filePath: string,
): Promise<InspectedDeviceClaim | null> {
  return await classifyDeviceClaimEntry(readDeviceClaimEntry(filePath));
}

/** Judges the owner of a claim file already read by {@link readDeviceClaimEntry}. */
export async function classifyDeviceClaimEntry(
  entry: InspectedDeviceClaim | null,
): Promise<InspectedDeviceClaim | null> {
  if (!entry?.claim) return entry;
  const observations = await readHostProcessIdentityObservationsAsync([entry.claim.ownerPid]);
  return classifyInspectedClaim(entry, observations.get(entry.claim.ownerPid) ?? null);
}

/**
 * One claim file, decoded and not judged: its `classification` is `unknown` until
 * {@link classifyDeviceClaimEntry} asks the host about the owner. A caller that compares only the
 * recorded owner token, pid, and start time needs no process-table read at all.
 */
export function readDeviceClaimEntry(filePath: string): InspectedDeviceClaim | null {
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
    const parsed = JSON.parse(contents) as unknown;
    const record = decodeStoredDeviceClaim(parsed);
    if (!record) return { fileName, classification: 'inconsistent' };
    return {
      fileName,
      deviceKey: record.deviceKey,
      claim: record,
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
 * The typed reason a caller gives when it refuses to take a device from the owner a classification
 * describes, or refuses to settle that owner's claim. `device release --stale` reports these for the
 * claims it leaves alone, and `device status` reports them as the reason a device is not acquirable,
 * so one vocabulary answers both.
 *
 * The dead and superseded entries describe owners that can no longer release their claim, for a claim
 * that still cannot be settled for a reason the owner is not: a claim file named for a different
 * device, or a settlement that never reached this claim.
 *
 * A lookup rather than a switch: a `Record` stays a flat table TypeScript still checks for
 * exhaustiveness, so a classification dropped from `DeviceClaimClassification` fails to compile here
 * exactly as it would a missing `case`.
 */
const DEVICE_CLAIM_REFUSAL_REASONS: Readonly<
  Record<DeviceClaimClassification, DeviceClaimRefusalReason>
> = Object.freeze({
  live: 'live-owner',
  'owner-process-reused': 'owner-pid-reused',
  'owner-state-dir-gone': 'owner-process-still-running',
  unknown: 'owner-liveness-unknown',
  inconsistent: 'claim-record-inconsistent',
  'owner-process-dead': 'claim-record-unreadable',
  'owner-daemon-superseded': 'claim-record-unreadable',
});

export type DeviceClaimRefusalReason =
  | 'live-owner'
  | 'owner-pid-reused'
  | 'owner-process-still-running'
  | 'owner-liveness-unknown'
  | 'claim-record-inconsistent'
  | 'claim-record-unreadable';

/** The refusal reason a classification names. A total lookup, so no caller re-derives it. */
export function deviceClaimRefusalReason(
  classification: DeviceClaimClassification,
): DeviceClaimRefusalReason {
  return DEVICE_CLAIM_REFUSAL_REASONS[classification];
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
