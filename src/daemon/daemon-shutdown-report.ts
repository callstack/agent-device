import fs from 'node:fs';
import path from 'node:path';
import type { DeviceLease } from './lease-registry.ts';

const SHUTDOWN_REPORT_FILE = 'daemon-shutdown.json';

export type ProviderReleaseRecord = {
  leaseId: string;
  provider?: string;
};

export type DaemonShutdownReport = {
  providerReleases: {
    released: ProviderReleaseRecord[];
    pending: ProviderReleaseRecord[];
  };
};

export function writeDaemonShutdownReport(
  stateDir: string,
  providerReleases: { released: readonly DeviceLease[]; pending: readonly DeviceLease[] },
): void {
  const report: DaemonShutdownReport = {
    providerReleases: {
      released: providerReleases.released.map(toProviderReleaseRecord),
      pending: providerReleases.pending.map(toProviderReleaseRecord),
    },
  };
  const filePath = shutdownReportPath(stateDir);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
  }
}

export function readDaemonShutdownReport(stateDir: string): DaemonShutdownReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(shutdownReportPath(stateDir), 'utf8')) as unknown;
    return isDaemonShutdownReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearDaemonShutdownReport(stateDir: string): void {
  try {
    fs.rmSync(shutdownReportPath(stateDir), { force: true });
  } catch {}
}

function shutdownReportPath(stateDir: string): string {
  return path.join(stateDir, SHUTDOWN_REPORT_FILE);
}

function toProviderReleaseRecord(lease: DeviceLease): ProviderReleaseRecord {
  return {
    leaseId: lease.leaseId,
    ...(lease.leaseProvider ? { provider: lease.leaseProvider } : {}),
  };
}

function isDaemonShutdownReport(value: unknown): value is DaemonShutdownReport {
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

function isProviderReleaseRecord(value: unknown): value is ProviderReleaseRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as { leaseId?: unknown; provider?: unknown };
  return (
    typeof record.leaseId === 'string' &&
    record.leaseId.trim().length > 0 &&
    (record.provider === undefined || typeof record.provider === 'string')
  );
}
