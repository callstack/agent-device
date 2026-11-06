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

export function inspectDeviceClaims(
  selectors: DeviceClaimSelectors,
  env: EnvMap,
): InspectedDeviceClaim[] {
  const root = resolveDeviceClaimRoot(env);
  const listed = readClaimEntries(root);
  if ('claims' in listed) return listed.claims;
  const parsed = listed.entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readDeviceClaimFile(path.join(root, entry.name)))
    .filter((entry): entry is InspectedDeviceClaim => entry !== null)
    .filter((entry) => matchesClaimSelectors(entry.claim, selectors));
  return classifiedClaimEntries(parsed, readHostProcessIdentityObservations(ownerPidsOf(parsed)));
}

function readClaimEntries(
  root: string,
): { entries: fs.Dirent[] } | { claims: InspectedDeviceClaim[] } {
  try {
    return { entries: fs.readdirSync(root, { withFileTypes: true }) };
  } catch (error) {
    return unreadableClaimRoot(root, error);
  }
}

/**
 * {@link inspectDeviceClaims} off the event loop, with the same classifications. Daemon request
 * paths answer through this one: the synchronous probe blocks the loop for the whole process-tool
 * snapshot, which stalls every other request, timer, and abort handler behind it.
 */
export async function inspectDeviceClaimsAsync(
  selectors: DeviceClaimSelectors,
  env: EnvMap,
): Promise<InspectedDeviceClaim[]> {
  const root = resolveDeviceClaimRoot(env);
  const listed = await readClaimEntriesAsync(root);
  if ('claims' in listed) return listed.claims;
  const parsed = (
    await Promise.all(
      listed.entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => readDeviceClaimFileAsync(path.join(root, entry.name))),
    )
  )
    .filter((entry): entry is InspectedDeviceClaim => entry !== null)
    .filter((entry) => matchesClaimSelectors(entry.claim, selectors));
  return classifiedClaimEntries(
    parsed,
    await readHostProcessIdentityObservationsAsync(ownerPidsOf(parsed)),
  );
}

async function readClaimEntriesAsync(
  root: string,
): Promise<{ entries: fs.Dirent[] } | { claims: InspectedDeviceClaim[] }> {
  try {
    return { entries: await fs.promises.readdir(root, { withFileTypes: true }) };
  } catch (error) {
    return unreadableClaimRoot(root, error);
  }
}

async function readDeviceClaimFileAsync(filePath: string): Promise<InspectedDeviceClaim | null> {
  const fileName = path.basename(filePath);
  try {
    return inspectClaimContents(fileName, await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    return unreadableClaimFile(fileName, error);
  }
}

function ownerPidsOf(parsed: readonly InspectedDeviceClaim[]): number[] {
  return parsed.flatMap((entry) => (entry.claim ? [entry.claim.ownerPid] : []));
}

function classifiedClaimEntries(
  parsed: readonly InspectedDeviceClaim[],
  observations: ReadonlyMap<number, HostProcessIdentityObservation>,
): InspectedDeviceClaim[] {
  return parsed.map((entry) =>
    entry.claim
      ? classifyInspectedClaim(entry, observations.get(entry.claim.ownerPid) ?? null)
      : entry,
  );
}

/** An absent claim root holds no claims; anything else is one unknown-evidence entry. */
function unreadableClaimRoot(root: string, error: unknown): { claims: InspectedDeviceClaim[] } {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { claims: [] };
  return {
    claims: [{ fileName: path.basename(root), classification: 'unknown', error: String(error) }],
  };
}

function unreadableClaimFile(fileName: string, error: unknown): InspectedDeviceClaim | null {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return null;
  return { fileName, classification: 'unknown', error: String(error) };
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
    return unreadableClaimFile(fileName, error);
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
