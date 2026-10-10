import fs from 'node:fs';
import path from 'node:path';
import type { DeviceLease } from '@agent-device/contracts/device';

const SHUTDOWN_REPORT_FILE = 'daemon-shutdown.json';

export type ProviderReleaseRecord = {
  leaseId: string;
  provider?: string;
};

/**
 * #1320: what happened to one session's device claim during graceful teardown.
 * `released` means the claim was confirmed gone after the session reached a safe
 * terminal state; `orphaned` means teardown left it in place, so the exiting
 * daemon's dead owner identity is what later proves it reclaimable; `superseded`
 * means another owner had already replaced it, so this daemon released nothing
 * and left nothing to reconcile; `unattributable` means a record is still there
 * that names no owner at all, which neither of the other two describes — see
 * `DaemonShutdownClaims.unattributable`.
 */
export type DeviceClaimRecord = {
  deviceKey: string;
  session: string;
  platform: string;
  deviceId: string;
};

export type DaemonShutdownReport = {
  providerReleases: {
    released: ProviderReleaseRecord[];
    pending: ProviderReleaseRecord[];
  };
  claims: {
    released: DeviceClaimRecord[];
    orphaned: DeviceClaimRecord[];
    superseded: DeviceClaimRecord[];
    unattributable: DeviceClaimRecord[];
  };
};

export type DaemonShutdownOutcome = {
  providerReleases: { released: readonly DeviceLease[]; pending: readonly DeviceLease[] };
  claims: {
    released: readonly DeviceClaimRecord[];
    orphaned: readonly DeviceClaimRecord[];
    superseded: readonly DeviceClaimRecord[];
    unattributable: readonly DeviceClaimRecord[];
  };
};

export function buildDaemonShutdownReport(outcome: DaemonShutdownOutcome): DaemonShutdownReport {
  return {
    providerReleases: {
      released: outcome.providerReleases.released.map(toProviderReleaseRecord),
      pending: outcome.providerReleases.pending.map(toProviderReleaseRecord),
    },
    claims: {
      released: [...outcome.claims.released],
      orphaned: [...outcome.claims.orphaned],
      superseded: [...outcome.claims.superseded],
      unattributable: [...outcome.claims.unattributable],
    },
  };
}

export function readDaemonShutdownReport(stateDir: string): DaemonShutdownReport | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(resolveDaemonShutdownReportPath(stateDir), 'utf8'),
    ) as unknown;
    if (!isProviderReleaseReport(parsed)) return null;
    // A report left behind by a daemon that predates claim reporting still
    // describes its provider releases honestly; it just knows nothing of claims.
    return { ...parsed, claims: readClaimSection(parsed) };
  } catch {
    return null;
  }
}

export function resolveDaemonShutdownReportPath(stateDir: string): string {
  return path.join(stateDir, SHUTDOWN_REPORT_FILE);
}

function toProviderReleaseRecord(lease: DeviceLease): ProviderReleaseRecord {
  return {
    leaseId: lease.leaseId,
    ...(lease.leaseProvider ? { provider: lease.leaseProvider } : {}),
  };
}

function isProviderReleaseReport(
  value: unknown,
): value is Omit<DaemonShutdownReport, 'claims'> & { claims?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const releases = (value as { providerReleases?: unknown }).providerReleases;
  if (!releases || typeof releases !== 'object') return false;
  const records = releases as { released?: unknown; pending?: unknown };
  return (
    Array.isArray(records.released) &&
    Array.isArray(records.pending) &&
    records.released.every(isProviderReleaseRecord) &&
    records.pending.every(isProviderReleaseRecord)
  );
}

function readClaimSection(value: { claims?: unknown }): DaemonShutdownReport['claims'] {
  const claims = value.claims;
  if (!claims || typeof claims !== 'object') {
    return { released: [], orphaned: [], superseded: [], unattributable: [] };
  }
  const records = claims as {
    released?: unknown;
    orphaned?: unknown;
    superseded?: unknown;
    unattributable?: unknown;
  };
  return {
    released: readClaimRecords(records.released),
    orphaned: readClaimRecords(records.orphaned),
    superseded: readClaimRecords(records.superseded),
    unattributable: readClaimRecords(records.unattributable),
  };
}

function readClaimRecords(value: unknown): DeviceClaimRecord[] {
  return Array.isArray(value) ? value.filter(isDeviceClaimRecord) : [];
}

function isDeviceClaimRecord(value: unknown): value is DeviceClaimRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Record<keyof DeviceClaimRecord, unknown>>;
  return (
    typeof record.deviceKey === 'string' &&
    typeof record.session === 'string' &&
    typeof record.platform === 'string' &&
    typeof record.deviceId === 'string'
  );
}

function isProviderReleaseRecord(value: unknown): value is ProviderReleaseRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as { leaseId?: unknown; provider?: unknown };
  return (
    typeof record.leaseId === 'string' &&
    record.leaseId.trim().length > 0 &&
    (record.provider === undefined || typeof record.provider === 'string')
  );
}
