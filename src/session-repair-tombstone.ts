import path from 'node:path';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';

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
  try {
    return readRepairTombstoneForCleanup(tombstonePath);
  } catch {
    return undefined;
  }
}

function readRepairTombstoneForCleanup(tombstonePath: string): RepairSessionTombstone | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(tombstonePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = parseRepairTombstone(raw, tombstonePath);
  return parsed.expiresAt > Date.now() ? parsed : undefined;
}

function parseRepairTombstone(raw: string, tombstonePath: string): RepairSessionTombstone {
  try {
    const parsed = JSON.parse(raw) as RepairSessionTombstone;
    if (
      !Number.isFinite(parsed?.expiresAt) ||
      typeof parsed?.owner !== 'string' ||
      !validRepairCommitFailure(parsed.commitFailure)
    )
      throw new Error('Invalid repair tombstone fields');
    return parsed;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Repair evidence could not be inspected.',
      { reason: 'repair_evidence_invalid', path: tombstonePath },
      error instanceof Error ? error : undefined,
    );
  }
}

function validRepairCommitFailure(value: unknown): boolean {
  const failure = value as RepairSessionTombstone['commitFailure'] | null;
  return (
    value === undefined ||
    (typeof failure?.code === 'string' && typeof failure?.message === 'string')
  );
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): scans every session
 * subdirectory under `sessionsDir` for a non-expired repair tombstone that
 * records an UNRECOVERED commit failure (`commitFailure` set) — used by the
 * CLIENT side of the daemon boundary (`cleanupDaemonAfterRequest` in
 * `daemon-client-lifecycle.ts`), which has no live `SessionStore`/session name
 * to key off of, only the filesystem path an owned ephemeral daemon was given.
 * Unreadable or malformed evidence throws so cleanup retains the directory.
 * An owned ephemeral state dir services exactly one repair transaction at a
 * time, so the first match found is returned.
 *
 * Lives at the process root, reachable by the store and the client alike (#2342), so reading
 * the artifact a reaped transaction left on disk does not oblige either side to import the other.
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tombstone = readRepairTombstoneForCleanup(
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
