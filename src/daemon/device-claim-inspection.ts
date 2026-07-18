import fs from 'node:fs';
import path from 'node:path';
import {
  deviceFieldsFromPublicPlatform,
  matchesPlatformSelector,
  type PlatformSelector,
} from '../kernel/device.ts';
import { classifyOwnerLiveness, type OwnerLiveness } from '../utils/owner-identity.ts';
import { resolveDeviceClaimRoot } from './device-claim-paths.ts';
import type { DeviceClaim } from './device-claims.ts';

const DEVICE_CLAIM_SCHEMA_VERSION = 1;

export type DeviceClaimClassification = OwnerLiveness | 'inconsistent';

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
  return listed.entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => inspectDeviceClaimFile(path.join(root, entry.name)))
    .filter((entry): entry is InspectedDeviceClaim => entry !== null)
    .filter((entry) => matchesClaimSelectors(entry.claim, selectors));
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
    { ...deviceFieldsFromPublicPlatform(claim.device.platform), appleOs: claim.device.appleOs },
    platform,
  );
}

export function inspectDeviceClaimFile(filePath: string): InspectedDeviceClaim | null {
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
      classification: classifyOwnerLiveness({
        owner: { pid: claim.ownerPid, startTime: claim.ownerStartTime },
        stateDir: claim.stateDir,
      }),
    };
  } catch (error) {
    return { fileName, classification: 'inconsistent', error: String(error) };
  }
}

function normalizeClaim(value: unknown): DeviceClaim | null {
  if (!isClaimObject(value)) return null;
  const raw = value as Partial<DeviceClaim>;
  return isValidClaimRecord(raw) ? (raw as DeviceClaim) : null;
}

function isClaimObject(value: unknown): value is object {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidClaimRecord(raw: Partial<DeviceClaim>): boolean {
  return (
    raw.schemaVersion === DEVICE_CLAIM_SCHEMA_VERSION &&
    isClaimDevice(raw.device) &&
    [raw.deviceKey, raw.session, raw.workspace, raw.stateDir, raw.ownerToken].every(
      isNonEmptyString,
    ) &&
    isPositiveInteger(raw.ownerPid) &&
    isFiniteNumber(raw.createdAtMs) &&
    isFiniteNumber(raw.updatedAtMs)
  );
}

function isClaimDevice(value: unknown): value is DeviceClaim['device'] {
  if (!isClaimObject(value)) return false;
  const device = value as Partial<DeviceClaim['device']>;
  return [device.id, device.name, device.platform, device.kind].every(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
