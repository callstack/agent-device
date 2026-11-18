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

/**
 * Reads one shutdown report's TEXT as a report, or `null` for a record it cannot vouch for.
 *
 * The parse is given text rather than a path on purpose. The report is a state record, and reading one starts
 * with the state chain and a verified, non-blocking, size-bounded open — `readPrivateStateFileSync` in
 * host-kit owns that, and a caller that read this name with `readFileSync` would believe a record another
 * local user planted, or stop on a FIFO at it (#4649). Absence and refusal are the same answer here: there
 * is no report.
 */
export function parseDaemonShutdownReport(text: string | undefined): DaemonShutdownReport | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isProviderReleaseReport(parsed)
      ? { providerReleases: parsed.providerReleases, claims: readClaimSection(parsed) }
      : null;
  } catch {
    return null;
  }
}

/** The most a shutdown report is ever read for: it names leases and claims, and a bounded read is what keeps
 * a huge file planted at this name from exhausting the process that stops a daemon. */
const DAEMON_SHUTDOWN_REPORT_MAX_BYTES = 1_048_576;

/**
 * Reads a state directory's shutdown report, or `null` when there is none to believe.
 *
 * A state record is read through the state boundary, never by opening its name: the chain rule decides who
 * else could have written that directory, and host-kit's verified reader then refuses a link, a special
 * file, or anything beyond the bound. Both refusals answer as absence, which is the same answer a client
 * gives for a daemon that wrote no report — a report another local user planted would otherwise hand this
 * stop plausible claim results that are not its own (#4649).
 *
 * The reader enters behind a function-scoped `await import` so this entry surface keeps the eager closure
 * the budget pins for it (ADR 0019): a client that only parses a text it already holds pays nothing.
 */
export async function readDaemonShutdownReport(
  stateDir: string,
): Promise<DaemonShutdownReport | null> {
  const { readPrivateStateFileSync } = await import('@agent-device/host-kit/file');
  return parseDaemonShutdownReport(
    readPrivateStateFileSync(
      resolveDaemonShutdownReportPath(stateDir),
      DAEMON_SHUTDOWN_REPORT_MAX_BYTES,
    ),
  );
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
