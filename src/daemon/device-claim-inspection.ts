import fs from 'node:fs';
import path from 'node:path';
import { matchesPlatformSelector, type PlatformSelector } from '@agent-device/kernel/device';
import {
  classifyOwnerLivenessFromObservation,
  type OwnerLiveness,
  readHostProcessIdentityObservations,
} from '@agent-device/host-kit/process';

import { isSupersededDaemonOwner } from './daemon-registration.ts';
import { resolveDeviceClaimRoot } from './device-claim-paths.ts';
import {
  decodeStoredDeviceClaim,
  isAllocatorHeldDeviceClaim,
  looksLikeAllocatorHeldClaim,
  type AllocatorHeldDeviceClaim,
  type DeviceClaim,
  type StoredDeviceClaim,
} from './device-claim-record.ts';

/**
 * `allocator-held` is a statement about the principal, not about liveness: the claim belongs to an
 * installation and an allocator identity incarnation, so there is no process to classify.
 * `allocator-inconsistent` is the same statement made unreliable: the raw record declares the
 * allocator schema version but does not decode, so it is not provably a non-allocator record.
 */
export type DeviceClaimClassification =
  | OwnerLiveness
  | 'inconsistent'
  | 'allocator-inconsistent'
  | 'owner-daemon-superseded'
  | 'allocator-held';

type ProcessOwnedClaimClassification = Exclude<DeviceClaimClassification, 'allocator-held'>;

/**
 * One inspected claim file. The two members keep the two principals apart by type: a reader that
 * reaches for `claim` gets the process-owned record or nothing, so ownership matching, stale
 * release, the startup sweep and session close cannot be written against an allocator-held claim.
 */
export type InspectedDeviceClaim = ProcessOwnedInspectedClaim | AllocatorHeldInspectedClaim;

type ProcessOwnedInspectedClaim = {
  fileName: string;
  deviceKey?: string;
  claim?: DeviceClaim;
  allocatorClaim?: undefined;
  classification: ProcessOwnedClaimClassification;
  error?: string;
};

type AllocatorHeldInspectedClaim = {
  fileName: string;
  deviceKey: string;
  claim?: undefined;
  allocatorClaim: AllocatorHeldDeviceClaim;
  classification: 'allocator-held';
  /** Never set: an entry only reaches this member once its record decoded. */
  error?: undefined;
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
    .filter((entry) => matchesClaimSelectors(entry.claim ?? entry.allocatorClaim, selectors));
  const observations = readHostProcessIdentityObservations(
    parsed.flatMap((entry) => (entry.claim ? [entry.claim.ownerPid] : [])),
  );
  return parsed.map((entry) =>
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
  claim: StoredDeviceClaim | undefined,
  selectors: DeviceClaimSelectors,
): boolean {
  if (!claim) return true;
  return [
    matchesClaimId(claim, selectors.udid ?? selectors.serial),
    matchesClaimDevice(claim, selectors.device),
    matchesClaimPlatform(claim, selectors.platform),
  ].every(Boolean);
}

function matchesClaimId(claim: StoredDeviceClaim, expectedId: string | undefined): boolean {
  return !expectedId || claim.device.id === expectedId;
}

function matchesClaimDevice(claim: StoredDeviceClaim, device: string | undefined): boolean {
  return !device || claim.device.name === device || claim.device.id === device;
}

function matchesClaimPlatform(
  claim: StoredDeviceClaim,
  platform: PlatformSelector | undefined,
): boolean {
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

/**
 * The allocator-held claim recorded at this path, or null for every record provably not one. This
 * kind carries its classification in the record itself, so — unlike {@link inspectDeviceClaimFile}
 * — nothing here probes host process identity. The ordinary claim gate asks this on every device
 * binding, and a claim whose owner is an installation has no process to probe.
 *
 * A record that declares the allocator schema version but fails to decode (for example, one
 * corrupted into also carrying a process principal) is not provably absent, so it is returned
 * too: the caller must refuse rather than treat the device as free for ordinary use.
 */
export function readAllocatorHeldClaimFile(filePath: string): InspectedDeviceClaim | null {
  const entry = readDeviceClaimFile(filePath);
  return entry?.allocatorClaim || entry?.classification === 'allocator-inconsistent' ? entry : null;
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
    const parsed = JSON.parse(contents) as unknown;
    const record = decodeStoredDeviceClaim(parsed);
    if (!record) {
      return {
        fileName,
        classification: looksLikeAllocatorHeldClaim(parsed)
          ? 'allocator-inconsistent'
          : 'inconsistent',
      };
    }
    if (isAllocatorHeldDeviceClaim(record)) {
      return {
        fileName,
        deviceKey: record.deviceKey,
        allocatorClaim: record,
        classification: 'allocator-held',
      };
    }
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
  entry: ProcessOwnedInspectedClaim,
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
    // Corrupted, not leftover: `--stale` release proofs a dead process, which this has none of.
    case 'allocator-inconsistent':
      return false;
    // An allocator-held claim is the normal state of a managed identity, not a leftover.
    case 'allocator-held':
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
    // No process proof applies to a record that never decoded far enough to name one.
    case 'allocator-inconsistent':
      return false;
    // Its owner is an installation, not a process, so no process proof can settle it: only the
    // allocator's removal proof clears it, through `releaseAllocatorHeldClaim`.
    case 'allocator-held':
      return false;
  }
}
