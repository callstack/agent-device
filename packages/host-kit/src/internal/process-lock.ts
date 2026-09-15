import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { publishFileSync } from './atomic-file.ts';
import { emitDiagnostic } from './diagnostics.ts';
import { classifyOwnerLiveness, ownerIdentityMatches } from './owner-identity.ts';
import { sleep } from './timeouts.ts';

const OWNER_FILE_NAME = 'owner.json';
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_LOCK_OWNER_GRACE_MS = 5_000;
const LOCK_DIRECTORY_SUFFIX = '.lock';
const RECLAIM_MUTEX_SUFFIX = '.reclaim';

export type ProcessLockOwner = {
  pid: number;
  startTime: string | null;
  acquiredAtMs: number;
};

/**
 * One acquisition of a lock. The token says which: two records can name the same process
 * and still be different claims on the same path, which is what a release and a reclaim
 * have to tell apart.
 */
export type ProcessLockOwnerRecord = ProcessLockOwner & {
  claimToken: string | null;
  /**
   * Which loading of this module issued the claim. A pid names a process, not a copy of this file:
   * two bundles of it in one process share the pid and the start time, and only one of them holds
   * the other's tokens. Absent on a record written before claims carried an issuer.
   */
  claimIssuerId?: string;
};

/** Gives a lock back. Rejects when the lock is standing and this process cannot prove it owns it. */
export type ProcessLockRelease = () => Promise<void>;

/**
 * Runs `task` while the lock that `acquire` returns is held, and settles the question every
 * caller otherwise answers by hand: which of two failures to report.
 *
 * A task that failed is the reportable fact, and an unverified release afterwards only says the
 * lock is still standing under a claim this process has spent, which the next reclaim here reads
 * as dead. On the success path the release is not best effort: a lock this process could not give
 * back is not a completed task, and swallowing it would report success while the next contender
 * waits.
 */
export async function withProcessLock<Task>(params: {
  acquire: () => Promise<ProcessLockRelease>;
  task: () => Promise<Task>;
}): Promise<Task> {
  const release = await params.acquire();
  try {
    const result = await params.task();
    await release();
    return result;
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

type ProcessLockOwnerReading =
  | { kind: 'owner'; owner: ProcessLockOwnerRecord }
  | { kind: 'unwritten' }
  | { kind: 'unreadable' };

/**
 * The claims this process is holding right now, by token. A record naming this pid is not
 * evidence that this process holds the lock: a release that could not verify ownership leaves its
 * record standing, and a handle dropped without a release does too. Both name a claim nobody here
 * is acting on, and only a token absent from this set can say so — the pid and start time outlive
 * the claim, so a reclaim that waited on those would wait until this process restarts while every
 * contender inside it times out on a lock that is already free.
 */
const liveClaimTokens = new Set<string>();

/** Which loading of this module issues this process's claims. See `ProcessLockOwnerRecord`. */
const CLAIM_ISSUER_ID = crypto.randomUUID();

export async function acquireProcessLock(params: {
  lockDirPath: string;
  owner: ProcessLockOwner;
  timeoutMs?: number;
  pollMs?: number;
  ownerGraceMs?: number;
  description?: string;
}): Promise<ProcessLockRelease> {
  const { lockDirPath, owner } = params;
  const ownerFilePath = path.join(lockDirPath, OWNER_FILE_NAME);
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = params.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const ownerGraceMs = params.ownerGraceMs ?? DEFAULT_LOCK_OWNER_GRACE_MS;
  const description = params.description ?? 'process lock';

  fs.mkdirSync(path.dirname(lockDirPath), { recursive: true });
  const claimToken = crypto.randomUUID();
  const claim: ProcessLockOwnerRecord = { ...owner, claimToken, claimIssuerId: CLAIM_ISSUER_ID };

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDirPath);
      writeProcessLockOwner(ownerFilePath, claim);
      liveClaimTokens.add(claimToken);
      let released = false;
      return async () => {
        if (released) return;
        // Asking to give the lock back ends the claim, whatever the removal below concludes.
        liveClaimTokens.delete(claimToken);
        const outcome = releaseProcessLock(lockDirPath, ownerFilePath, claim);
        if (outcome !== 'unverified') {
          released = true;
          return;
        }
        // The record still names us as far as we can tell and we could not read far
        // enough to be sure, so the lock stays in place and the caller hears why.
        emitDiagnostic({
          level: 'warn',
          phase: 'process_lock_release_unverified',
          data: {
            lockDirPath,
            description,
            ownerReleaseUnverified: true,
          },
        });
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

function writeProcessLockOwner(ownerFilePath: string, owner: ProcessLockOwnerRecord): void {
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
  claim: ProcessLockOwnerRecord,
): 'removed' | 'not-owner' | 'unverified' {
  const reading = readProcessLockOwner(ownerFilePath);
  if (reading.kind === 'unreadable') return 'unverified';
  if (reading.kind === 'unwritten' || !ownerIdentityMatches(reading.owner, claim))
    return 'not-owner';
  // The same process can hold this path twice in sequence, so the token is what tells this
  // acquisition's record from an earlier one that names the very same process.
  if (reading.owner.claimToken !== claim.claimToken) return 'not-owner';
  return clearLockDirectory(lockDirPath, ownerFilePath);
}

/**
 * A lock directory is written by this module and holds one file: its record. So it is emptied
 * and removed rather than removed with everything inside, and a directory that turns out to
 * hold something else is left standing. That distinction is the difference between clearing a
 * lock and destroying whoever put their thing in that path.
 */
function clearLockDirectory(lockDirPath: string, ownerFilePath: string): 'removed' | 'unverified' {
  try {
    fs.unlinkSync(ownerFilePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return 'unverified';
  }
  try {
    fs.rmdirSync(lockDirPath);
    return 'removed';
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'removed' : 'unverified';
  }
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
    return (
      reclaimWhenAbandoned(lockStats, ownerGraceMs) &&
      reclaimLockUnderMutex(lockDirPath, ownerFilePath, ownerGraceMs, { kind: 'stray' })
    );
  }

  const reading = readProcessLockOwner(ownerFilePath);
  if (reading.kind === 'owner') {
    // A record identifies the acquisition that wrote it, so the directory around a claim judged
    // dead is that claim's property. The claim can be dead while the process that wrote it is
    // live, which is what the token says and the pid cannot.
    return (
      (!isLiveProcessLockOwner(reading.owner) || isSpentOwnClaim(reading.owner)) &&
      reclaimLockUnderMutex(lockDirPath, ownerFilePath, ownerGraceMs, {
        kind: 'dead-claim',
        claimToken: reading.owner.claimToken,
      })
    );
  }
  // A record we cannot read leaves an owner whose identity is unknown, which is not
  // evidence of death. Only a record that is genuinely absent lets the directory's
  // own age speak for it.
  if (reading.kind === 'unreadable') {
    return false;
  }
  return (
    reclaimWhenAbandoned(lockStats, ownerGraceMs) &&
    reclaimLockUnderMutex(lockDirPath, ownerFilePath, ownerGraceMs, { kind: 'empty' })
  );
}

function reclaimWhenAbandoned(lockStats: fs.Stats, ownerGraceMs: number): boolean {
  return Date.now() - lockStats.mtimeMs >= ownerGraceMs;
}

/**
 * What the judgement outside the mutex found, in the one form the removal decision needs: a claim
 * whose owner is dead, a directory that has never held a record, or a path that is not one.
 */
type JudgedLock =
  | { kind: 'dead-claim'; claimToken: ProcessLockOwnerRecord['claimToken'] }
  | { kind: 'empty' }
  | { kind: 'stray' };

/**
 * An abandoned lock is the one directory this module destroys without having created it, and
 * two contenders that both remove it independently both walk away believing they freed the
 * path. So the decision is taken again inside a mutex of its own, aged by the same grace as the
 * lock it guards, and everyone who cannot hold it keeps polling.
 *
 * Nothing is moved out of the way first: an absent lock path is an invitation, and a lock parked
 * under another name would return to a path somebody else already wrote a record on. Each branch
 * re-decides from what is on disk now and removes in place, and a path that has already gone is
 * left untouched so the caller's next `mkdir` simply wins it.
 */
function reclaimLockUnderMutex(
  lockDirPath: string,
  ownerFilePath: string,
  ownerGraceMs: number,
  judged: JudgedLock,
): boolean {
  if (!holdReclaimMutex(lockDirPath, ownerGraceMs)) return false;
  try {
    switch (judged.kind) {
      case 'dead-claim':
        return removeDeadClaimLock(lockDirPath, ownerFilePath, judged.claimToken);
      case 'empty':
        return removeAbandonedEmptyLock(lockDirPath, ownerGraceMs);
      case 'stray':
        return removeStrayLockPath(lockDirPath);
    }
  } finally {
    releaseReclaimMutex(lockDirPath);
  }
}

/**
 * The mutex says no other contender is reclaiming. It says nothing about the lock's owner, who
 * may have released the path and handed it to someone new while this process took the mutex, so
 * the record decides: a claim token is a random id no later acquisition can repeat, and a
 * directory whose record carries any other token, or no record at all, belongs to somebody else.
 */
function removeDeadClaimLock(
  lockDirPath: string,
  ownerFilePath: string,
  claimToken: ProcessLockOwnerRecord['claimToken'],
): boolean {
  const reading = readProcessLockOwner(ownerFilePath);
  if (reading.kind !== 'owner' || reading.owner.claimToken !== claimToken) return false;
  try {
    fs.rmSync(lockDirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory that has never held a record has no claim to attribute its contents to, so `rmdir`
 * is the only call made on it: it cannot destroy what a new owner published between the judgement
 * and here, and `ENOTEMPTY` is that publication saying so. Age re-speaks for the same reason — a
 * directory created a moment ago is an acquisition that has not published yet, not an abandoned one.
 */
function removeAbandonedEmptyLock(lockDirPath: string, ownerGraceMs: number): boolean {
  let current: fs.Stats;
  try {
    current = fs.statSync(lockDirPath);
  } catch {
    return false;
  }
  if (!current.isDirectory() || !reclaimWhenAbandoned(current, ownerGraceMs)) return false;
  try {
    fs.rmdirSync(lockDirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * `unlink` answers `EISDIR` for a directory, which is a claim this process never held, so the
 * system call itself refuses the one case this branch must not touch.
 */
function removeStrayLockPath(lockDirPath: string): boolean {
  try {
    fs.unlinkSync(lockDirPath);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the `.lock` suffix so a sibling scanner still reads the name as a lock. */
function reclaimMutexPath(lockDirPath: string): string {
  const stem = lockDirPath.endsWith(LOCK_DIRECTORY_SUFFIX)
    ? lockDirPath.slice(0, -LOCK_DIRECTORY_SUFFIX.length)
    : lockDirPath;
  return `${stem}${RECLAIM_MUTEX_SUFFIX}${LOCK_DIRECTORY_SUFFIX}`;
}

function holdReclaimMutex(lockDirPath: string, abandonedAfterMs: number): boolean {
  const mutexPath = reclaimMutexPath(lockDirPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(mutexPath);
      return true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (!clearAbandonedReclaimMutex(mutexPath, abandonedAfterMs)) return false;
    }
  }
  return false;
}

/**
 * A mutex left behind by a process that died mid-reclaim is cleared by age, the same evidence
 * an abandoned lock is judged by. Two contenders may both decide to clear it; the `mkdir` that
 * follows still admits one of them.
 */
function clearAbandonedReclaimMutex(mutexPath: string, abandonedAfterMs: number): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(mutexPath);
  } catch {
    return true;
  }
  if (Date.now() - stats.mtimeMs < abandonedAfterMs) return false;
  try {
    fs.rmdirSync(mutexPath);
  } catch {}
  return true;
}

function releaseReclaimMutex(lockDirPath: string): void {
  try {
    fs.rmdirSync(reclaimMutexPath(lockDirPath));
  } catch {}
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
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

function parseProcessLockOwner(contents: string): ProcessLockOwnerRecord | null {
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
    // A record written before claims were tokenized names a process without saying which
    // acquisition it was, which no release can match and no reclaim can be blamed for.
    claimToken: typeof record.claimToken === 'string' ? record.claimToken : null,
    claimIssuerId: typeof record.claimIssuerId === 'string' ? record.claimIssuerId : undefined,
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

/**
 * This process wrote the record and nothing inside it is acting on that claim any more: a release
 * that could not verify ownership left it standing, or a handle was dropped without one. Waiting
 * for the pid would be waiting for this process to restart.
 */
function isSpentOwnClaim(owner: ProcessLockOwnerRecord): boolean {
  if (owner.pid !== process.pid || owner.claimToken === null) return false;
  // A token this loading of the module never issued is either a claim by another loading in the
  // same process, which is live and not ours to judge, or a record from before issuers existed,
  // which is no evidence of a spent claim either. Both stay subject to the liveness answer.
  if (owner.claimIssuerId !== CLAIM_ISSUER_ID) return false;
  return !liveClaimTokens.has(owner.claimToken);
}
