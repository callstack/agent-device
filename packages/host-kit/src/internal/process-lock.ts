import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { publishFileSync } from './atomic-file.ts';
import { classifyOwnerLiveness, ownerIdentityMatches } from './owner-identity.ts';
import { sleep } from './timeouts.ts';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_LOCK_OWNER_GRACE_MS = 5_000;
const LOCK_DIRECTORY_SUFFIX = '.lock';

export type ProcessLockOwner = {
  pid: number;
  startTime: string | null;
  acquiredAtMs: number;
};

type ProcessLockOwnerReading =
  | { kind: 'owner'; owner: ProcessLockOwner }
  | { kind: 'unwritten' }
  | { kind: 'unreadable' };

export async function acquireProcessLock(params: {
  lockDirPath: string;
  owner: ProcessLockOwner;
  timeoutMs?: number;
  pollMs?: number;
  ownerGraceMs?: number;
  description?: string;
}): Promise<() => Promise<void>> {
  const { lockDirPath, owner } = params;
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = params.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const ownerGraceMs = params.ownerGraceMs ?? DEFAULT_LOCK_OWNER_GRACE_MS;
  const description = params.description ?? 'process lock';

  fs.mkdirSync(path.dirname(lockDirPath), { recursive: true });

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDirPath);
      writeProcessLockOwner(ownerFilePath, owner);
      let released = false;
      return async () => {
        if (released) return;
        const outcome = releaseProcessLock(lockDirPath, ownerFilePath, owner);
        if (outcome !== 'unverified') {
          released = true;
          return;
        }
        // The record still names us as far as we can tell and we could not read far
        // enough to be sure, so the lock stays in place and the caller hears why.
        throw new AppError('COMMAND_FAILED', `Cannot verify ownership of ${description}`, {
          lockDirPath,
          ownerReleaseUnverified: true,
          hint: staleLockHint(lockDirPath),
        });
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw err;
      }
      if (clearStaleProcessLock(lockDirPath, ownerFilePath, ownerGraceMs)) {
        continue;
      }
      await sleep(pollMs);
    }
  }

  const reading = readProcessLockOwner(ownerFilePath);
  throw new AppError('COMMAND_FAILED', `Timed out waiting for ${description}`, {
    lockDirPath,
    ...readProcessLockDiagnostics(lockDirPath, reading),
    ...(reading.kind === 'unreadable' ? { hint: staleLockHint(lockDirPath) } : {}),
  });
}

function staleLockHint(lockDirPath: string): string {
  return `Remove ${lockDirPath} once you have confirmed no live process holds it, then retry.`;
}

function writeProcessLockOwner(ownerFilePath: string, owner: ProcessLockOwner): void {
  publishFileSync({
    destination: ownerFilePath,
    contents: JSON.stringify(owner),
  });
}

/**
 * Removes the lock only while the record inside still names this acquirer. A lock
 * that was reclaimed from under us belongs to whoever publishes there now, and
 * deleting that directory would hand its holder's exclusion to a third contender.
 */
function releaseProcessLock(
  lockDirPath: string,
  ownerFilePath: string,
  owner: ProcessLockOwner,
): 'removed' | 'not-owner' | 'unverified' {
  const reading = readProcessLockOwner(ownerFilePath);
  if (reading.kind === 'unreadable') return 'unverified';
  if (reading.kind === 'unwritten' || !ownerIdentityMatches(reading.owner, owner))
    return 'not-owner';
  fs.rmSync(lockDirPath, { recursive: true, force: true });
  return 'removed';
}

function clearStaleProcessLock(
  lockDirPath: string,
  ownerFilePath: string,
  ownerGraceMs: number,
): boolean {
  let lockStats: fs.Stats;
  try {
    lockStats = fs.statSync(lockDirPath);
  } catch {
    return true;
  }

  // A lock path held by anything that is not a directory cannot carry a readable
  // owner record, so its age is the only evidence available about it.
  if (!lockStats.isDirectory()) {
    return reclaimWhenAbandoned(lockStats, ownerGraceMs)
      ? reclaimProcessLockDirectory(lockDirPath, ownerFilePath)
      : false;
  }

  const reading = readProcessLockOwner(ownerFilePath);
  if (reading.kind === 'owner') {
    if (isLiveProcessLockOwner(reading.owner)) {
      return false;
    }
    return reclaimProcessLockDirectory(lockDirPath, ownerFilePath);
  }
  // A record we cannot read leaves an owner whose identity is unknown, which is not
  // evidence of death. Only a record that is genuinely absent lets the directory's
  // own age speak for it.
  if (reading.kind === 'unreadable') {
    return false;
  }
  return reclaimWhenAbandoned(lockStats, ownerGraceMs)
    ? reclaimProcessLockDirectory(lockDirPath, ownerFilePath)
    : false;
}

function reclaimWhenAbandoned(lockStats: fs.Stats, ownerGraceMs: number): boolean {
  return Date.now() - lockStats.mtimeMs >= ownerGraceMs;
}

/**
 * Moves the abandoned directory aside under a unique name before removing it, so
 * exactly one contender can reclaim one lock. Two plain removals look different from
 * the caller's side: the second succeeds silently on the path the first already
 * cleared, and both contenders continue as though they had freed the lock. `mkdir`'s
 * `EEXIST`, unchanged, stays the arbiter of the lock itself.
 *
 * A win32 directory with a handle open inside it refuses the rename and often the
 * removal too, which is why a forced removal remains as the fallback: stale-clear
 * atomicity is best effort there and exact elsewhere. The fallback re-reads the
 * record first, because a refused rename means time passed and a live contender may
 * have claimed the path in it.
 */
function reclaimProcessLockDirectory(lockDirPath: string, ownerFilePath: string): boolean {
  const asidePath = reclaimedLockPath(lockDirPath);
  try {
    fs.renameSync(lockDirPath, asidePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return true;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTEMPTY') return false;
    const reading = readProcessLockOwner(ownerFilePath);
    if (reading.kind === 'owner' && isLiveProcessLockOwner(reading.owner)) return false;
    fs.rmSync(lockDirPath, { recursive: true, force: true });
    return true;
  }
  removeReclaimedLockDirectory(asidePath);
  return true;
}

/** Janitorial work after the rename already achieved the exclusion. */
function removeReclaimedLockDirectory(asidePath: string): void {
  try {
    fs.rmSync(asidePath, { recursive: true, force: true });
  } catch {}
}

/** Keeps the `.lock` suffix so a sibling scanner still reads the name as a lock. */
function reclaimedLockPath(lockDirPath: string): string {
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const stem = lockDirPath.endsWith(LOCK_DIRECTORY_SUFFIX)
    ? lockDirPath.slice(0, -LOCK_DIRECTORY_SUFFIX.length)
    : lockDirPath;
  return `${stem}.reclaimed-${token}${LOCK_DIRECTORY_SUFFIX}`;
}

/**
 * `ENOENT` is the only failure that means no record was written yet. Any other error,
 * and any record that does not name a process, says a record exists that we cannot
 * read, which is an owner of unknown liveness rather than an absent one.
 */
function readProcessLockOwner(ownerFilePath: string): ProcessLockOwnerReading {
  let contents: string;
  try {
    contents = fs.readFileSync(ownerFilePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' ? { kind: 'unwritten' } : { kind: 'unreadable' };
  }
  const owner = parseProcessLockOwner(contents);
  return owner ? { kind: 'owner', owner } : { kind: 'unreadable' };
}

function parseProcessLockOwner(contents: string): ProcessLockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const [field, holdsShape] of Object.entries(PROCESS_LOCK_OWNER_FIELD_SHAPES)) {
    if (!holdsShape(record[field])) return null;
  }
  return {
    pid: record.pid as number,
    startTime: typeof record.startTime === 'string' ? record.startTime : null,
    acquiredAtMs: record.acquiredAtMs as number,
  };
}

const PROCESS_LOCK_OWNER_FIELD_SHAPES: Record<keyof ProcessLockOwner, (value: unknown) => boolean> =
  {
    pid: (value) => typeof value === 'number' && Number.isInteger(value) && value > 0,
    acquiredAtMs: (value) => typeof value === 'number' && Number.isFinite(value),
    startTime: (value) => value === undefined || value === null || typeof value === 'string',
  };

function readProcessLockDiagnostics(
  lockDirPath: string,
  reading: ProcessLockOwnerReading,
): Record<string, unknown> {
  const nowMs = Date.now();
  let lockAgeMs: number | undefined;
  try {
    lockAgeMs = Math.max(0, Math.round(nowMs - fs.statSync(lockDirPath).mtimeMs));
  } catch {}
  return {
    ...(lockAgeMs !== undefined ? { lockAgeMs } : {}),
    ...(reading.kind === 'owner'
      ? {
          ownerPid: reading.owner.pid,
          ownerStartTime: reading.owner.startTime,
          ownerAgeMs: Math.max(0, Math.round(nowMs - reading.owner.acquiredAtMs)),
          ownerLiveness: classifyOwnerLiveness({ owner: reading.owner }),
        }
      : reading.kind === 'unreadable'
        ? { ownerRecordUnreadable: true }
        : {}),
  };
}

function isLiveProcessLockOwner(owner: ProcessLockOwner): boolean {
  const liveness = classifyOwnerLiveness({ owner });
  return liveness !== 'owner-process-dead' && liveness !== 'owner-process-reused';
}
