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

/**
 * The lifetime that wrote a report: the daemon's own pid and process start time.
 *
 * A report is read AFTER a stop, from a directory that outlives every daemon run in it, so the name alone
 * cannot say which lifetime's cleanup it describes. A start time is what tells two runs of the same pid
 * apart: without it, a report an earlier daemon left (because this run's own write was refused) would be
 * read as the cleanup of the daemon that just stopped, and its claims would be reported as devices this
 * daemon released.
 */
export type DaemonShutdownReportAuthor = Readonly<{
  pid: number;
  startTime: string | null;
}>;

export type DaemonShutdownOutcome = {
  providerReleases: { released: readonly DeviceLease[]; pending: readonly DeviceLease[] };
  claims: {
    released: readonly DeviceClaimRecord[];
    orphaned: readonly DeviceClaimRecord[];
    superseded: readonly DeviceClaimRecord[];
    unattributable: readonly DeviceClaimRecord[];
  };
};

export function buildDaemonShutdownReport(
  outcome: DaemonShutdownOutcome,
  author: DaemonShutdownReportAuthor,
): DaemonShutdownReport & { writtenBy: DaemonShutdownReportAuthor } {
  return {
    writtenBy: { pid: author.pid, startTime: author.startTime },
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
 * The parse is given text rather than a path on purpose: reading the name is a different owner's job, and this
 * one answers only for the shape of what it is handed — including whose lifetime handed it.
 *
 * `writtenBy` is read when the record states one, and a record that names an author answers ONLY for that
 * lifetime. A report that states no author predates the field, which is the same additive case as a report
 * that predates the claims section: its known parts are still read.
 */
function parseDaemonShutdownReport(
  text: string | undefined,
  expectedAuthor: DaemonShutdownReportAuthor | undefined,
): DaemonShutdownReport | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isProviderReleaseReport(parsed)) return null;
    const author = readReportAuthor(parsed);
    if (author && expectedAuthor && !reportAuthorMatches(author, expectedAuthor)) return null;
    return { providerReleases: parsed.providerReleases, claims: readClaimSection(parsed) };
  } catch {
    return null;
  }
}

function readReportAuthor(value: { writtenBy?: unknown }): DaemonShutdownReportAuthor | undefined {
  const stated = value.writtenBy as Readonly<{ pid?: unknown; startTime?: unknown }> | undefined;
  if (!stated || !Number.isInteger(stated.pid) || (stated.pid as number) <= 0) return undefined;
  if (stated.startTime !== null && typeof stated.startTime !== 'string') return undefined;
  return { pid: stated.pid as number, startTime: (stated.startTime as string | null) ?? null };
}

/**
 * Whether a report names the lifetime the caller stopped. Equal pids are NOT the same run: `startTime` is
 * what tells a recycled pid apart, the same fact every other daemon record is correlated by. A record whose
 * author cannot be compared — a start time either side does not state — is not proof of being this run's, so
 * it answers `false` and the stop reports its cleanup confidence as unknown rather than known.
 */
function reportAuthorMatches(
  author: DaemonShutdownReportAuthor,
  expected: DaemonShutdownReportAuthor,
): boolean {
  return author.pid === expected.pid && author.startTime === expected.startTime;
}

/** The most a shutdown report is ever read for: it names leases and claims, and a bounded read is what keeps
 * a huge file planted at this name from exhausting the process that stops a daemon. */
const DAEMON_SHUTDOWN_REPORT_MAX_BYTES = 1_048_576;

/**
 * Reads a state directory's shutdown report, or `null` when there is none to believe.
 *
 * A state record is read through the state boundary, never by opening its name: the chain rule decides who
 * else could have written that directory, and host-kit's verified reader then refuses a link, a special file,
 * or anything beyond the bound. Both refusals answer as absence, which is the same answer a client gives for a
 * daemon that wrote no report — a report another local user planted would otherwise hand this stop plausible
 * claim results that are not its own (#4649).
 *
 * `writtenBy` asks for ONE lifetime's report and no other. The state directory outlives every daemon run in
 * it, so a report an earlier run left is a real state record that describes a different cleanup: a stop that
 * read it would tell its caller devices were released by the daemon that just exited. A record that names an
 * author is therefore believed only while that author is the lifetime the caller stopped; a start time is what
 * tells a recycled pid apart.
 *
 * The bound is asked as a WHOLE-record bound, not a tail one: a reader that kept the last megabyte of a
 * file padded in front would parse the planted tail of somebody else's bytes as this daemon's report.
 *
 * The reader enters behind a function-scoped `await import` so this entry surface keeps the eager closure
 * the budget pins for it (ADR 0019): a client that only parses a text it already holds pays nothing.
 */
export async function readDaemonShutdownReport(
  stateDir: string,
  writtenBy?: DaemonShutdownReportAuthor,
): Promise<DaemonShutdownReport | null> {
  const { readPrivateStateWholeFileSync } = await import('@agent-device/host-kit/file');
  return parseDaemonShutdownReport(
    readPrivateStateWholeFileSync(
      resolveDaemonShutdownReportPath(stateDir),
      DAEMON_SHUTDOWN_REPORT_MAX_BYTES,
    ),
    writtenBy,
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

function isProviderReleaseReport(value: unknown): value is Omit<DaemonShutdownReport, 'claims'> & {
  claims?: unknown;
  writtenBy?: unknown;
} {
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
