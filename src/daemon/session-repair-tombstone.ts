import path from 'node:path';
import fs from 'node:fs';

/**
 * ADR 0012 decision 6, R7 (C5a): a reaped repair session leaves this bounded
 * marker so the next command on the same key gets `REPAIR_SESSION_EXPIRED` +
 * re-run guidance, never a bare `SESSION_NOT_FOUND`. Bounded by `expiresAt`
 * so an old tombstone never shadows an unrelated future session name.
 */
export type RepairSessionTombstone = {
  owner: string;
  reapedAt: number;
  expiresAt: number;
  sourcePath?: string;
  /**
   * ADR 0012 decision 6 (BLOCKER 2): set iff this tombstone marks a COMPLETE
   * transaction whose commit FAILED at teardown (no-clobber refusal, bare
   * `@ref`, or a filesystem write error) — as opposed to a transaction that
   * was merely reaped before it ever finished. Preserves the real failure
   * instead of losing it behind a generic "reaped before it was finalized"
   * expiry, so `repairExpiredIfTombstoned` can surface a distinct
   * `REPAIR_COMMIT_FAILED` with the actual cause.
   */
  commitFailure?: { code: string; message: string };
};

/** The tombstone file inside one session directory. Single owner of the file name. */
export function resolveRepairTombstonePath(sessionDir: string): string {
  return path.join(sessionDir, 'repair-tombstone.json');
}

/** Parses/validates a tombstone file at `tombstonePath`; `undefined` if missing, malformed, or expired. */
export function readRepairTombstoneFile(tombstonePath: string): RepairSessionTombstone | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(tombstonePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: RepairSessionTombstone;
  try {
    parsed = JSON.parse(raw) as RepairSessionTombstone;
  } catch {
    return undefined;
  }
  if (typeof parsed?.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) return undefined;
  return parsed;
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): scans every session
 * subdirectory under `sessionsDir` for a non-expired repair tombstone that
 * records an UNRECOVERED commit failure (`commitFailure` set) — used by the
 * CLIENT side of the daemon boundary (`cleanupDaemonAfterRequest` in
 * `daemon-client-lifecycle.ts`), which has no live `SessionStore`/session name
 * to key off of, only the filesystem path an owned ephemeral daemon was given.
 * An owned ephemeral state dir services exactly one repair transaction at a
 * time, so the first match found is returned.
 *
 * Lives below both the store and the client (#2342) so reading the artifact a
 * reaped transaction left on disk does not oblige either side to import the
 * other.
 */
export function findUnrecoveredRepairCommitFailure(sessionsDir: string):
  | {
      sessionName: string;
      tombstone: RepairSessionTombstone & {
        commitFailure: NonNullable<RepairSessionTombstone['commitFailure']>;
      };
    }
  | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tombstone = readRepairTombstoneFile(
      resolveRepairTombstonePath(path.join(sessionsDir, entry.name)),
    );
    if (tombstone?.commitFailure) {
      return {
        sessionName: entry.name,
        tombstone: { ...tombstone, commitFailure: tombstone.commitFailure },
      };
    }
  }
  return undefined;
}
