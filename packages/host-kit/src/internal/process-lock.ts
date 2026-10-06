import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { publishFileSync } from './atomic-file.ts';
import { emitDiagnostic } from './diagnostics.ts';
import {
  classifyOwnerLiveness,
  isProcessPid,
  ownerIdentityMatches,
  type OwnerLiveness,
} from './owner-identity.ts';
import { sleep } from './timeouts.ts';

const OWNER_FILE_NAME = 'owner.json';
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;
const LOCK_DIRECTORY_SUFFIX = '.lock';
const RECLAIM_MUTEX_SUFFIX = '.reclaim';
const RELEASE_GUARD_WAIT_MS = 5_000;
const RELEASE_GUARD_POLL_MS = 5;

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

export type ProcessLockInspection =
  | Readonly<{ state: 'absent' | 'publishing' }>
  | Readonly<{
      state: 'unproven';
      reason: 'non-directory' | 'owner-unwritten' | 'owner-unreadable';
    }>
  | Readonly<{ state: 'held'; owner: ProcessLockOwner; liveness: OwnerLiveness }>;

export type ProcessLockAcquisition = Readonly<{
  assertHeld(): void;
  release: ProcessLockRelease;
}>;

export type ProcessLockAttempt =
  | Readonly<{ status: 'acquired'; acquisition: ProcessLockAcquisition }>
  | Readonly<{ status: 'busy' | 'unproven'; inspection: ProcessLockInspection }>;

type ProcessLockOptions = {
  lockDirPath: string;
  owner: ProcessLockOwner;
  description?: string;
};

export function inspectProcessLock(lockDirPath: string): ProcessLockInspection {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lockDirPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { state: 'unproven', reason: 'owner-unreadable' };
    return { state: fs.existsSync(reclaimMutexPath(lockDirPath)) ? 'publishing' : 'absent' };
  }
  if (!stats.isDirectory()) return { state: 'unproven', reason: 'non-directory' };
  const reading = readProcessLockOwner(path.join(lockDirPath, OWNER_FILE_NAME));
  if (reading.kind === 'unreadable') return { state: 'unproven', reason: 'owner-unreadable' };
  if (reading.kind === 'unwritten') {
    return fs.existsSync(reclaimMutexPath(lockDirPath))
      ? { state: 'publishing' }
      : { state: 'unproven', reason: 'owner-unwritten' };
  }
  const { pid, startTime, acquiredAtMs } = reading.owner;
  return {
    state: 'held',
    owner: { pid, startTime, acquiredAtMs },
    liveness: classifyOwnerLiveness({ owner: reading.owner }),
  };
}

/**
 * Makes one attempt. Publication, reclaim and release share a non-expiring mutation guard.
 * All users of this path must use this protocol. Drain legacy users before upgrading and
 * prevent them from returning: a guard cannot revoke a legacy reclaimer already admitted.
 * See docs/adr/0030-process-lock-exclusion.md for the migration contract.
 */
export function tryAcquireProcessLock(params: ProcessLockOptions): ProcessLockAttempt {
  const { lockDirPath } = params;
  fs.mkdirSync(path.dirname(lockDirPath), { recursive: true });
  const judgment = judgeStandingClaim(path.join(lockDirPath, OWNER_FILE_NAME));
  if (judgment.kind === 'live') return { status: 'busy', inspection: judgment.inspection };
  if (!holdReclaimMutex(lockDirPath)) {
    return { status: 'busy', inspection: inspectProcessLock(lockDirPath) };
  }
  const outcome = withMutationGuardHeld(
    lockDirPath,
    () => acquireUnderMutationGuard(params, judgment),
    (abandoned) => {
      if (abandoned.status === 'acquired') liveClaimTokens.delete(abandoned.claimToken);
    },
  );
  if (outcome.status === 'acquired') {
    return { status: 'acquired', acquisition: outcome.acquisition };
  }
  return {
    status: outcome.status,
    inspection: outcome.inspection ?? inspectProcessLock(lockDirPath),
  };
}

/** Runs `step` while this process holds the guard, then gives the guard back on every path. */
function withMutationGuardHeld<Result>(
  lockDirPath: string,
  step: () => Result,
  abandon: (result: Result) => void,
): Result {
  let result: Result;
  try {
    result = step();
  } catch (error) {
    try {
      releaseReclaimMutex(lockDirPath);
    } catch (releaseError) {
      emitDiagnostic({
        level: 'warn',
        phase: 'process_lock_guard_release_failed',
        data: { lockDirPath, error: normalizeError(releaseError) },
      });
    }
    throw error;
  }
  try {
    releaseReclaimMutex(lockDirPath);
  } catch (error) {
    abandon(result);
    throw error;
  }
  return result;
}

// Only filesystem compare-and-mutate steps run here. A process probe holding the guard would turn
// a waiter killed mid-probe into a guard nobody removes.
function acquireUnderMutationGuard(
  params: ProcessLockOptions,
  judgment: StandingClaimJudgment,
): GuardedAcquisitionOutcome {
  const { lockDirPath } = params;
  const ownerFilePath = path.join(lockDirPath, OWNER_FILE_NAME);
  const standing = readLockDirectory(lockDirPath, ownerFilePath);
  if (standing.kind === 'unproven') {
    return { status: 'unproven', inspection: standing.inspection };
  }
  if (standing.kind === 'owner') {
    if (judgment.kind !== 'reclaimable' || !isSameClaim(standing.owner, judgment.owner)) {
      return { status: 'busy' };
    }
    if (releaseProcessLock(lockDirPath, ownerFilePath, standing.owner) !== 'removed') {
      return { status: 'unproven' };
    }
  }
  return publishClaim(params, ownerFilePath);
}

function publishClaim(
  params: ProcessLockOptions,
  ownerFilePath: string,
): GuardedAcquisitionOutcome {
  const { lockDirPath, owner } = params;
  try {
    fs.mkdirSync(lockDirPath);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return { status: 'unproven' };
  }
  const claimToken = crypto.randomUUID();
  const claim: ProcessLockOwnerRecord = { ...owner, claimToken, claimIssuerId: CLAIM_ISSUER_ID };
  try {
    writeProcessLockOwner(ownerFilePath, claim);
  } catch (error) {
    try {
      fs.rmdirSync(lockDirPath);
    } catch {}
    throw error;
  }
  liveClaimTokens.add(claimToken);
  return {
    status: 'acquired',
    claimToken,
    acquisition: createProcessLockAcquisition(params, claim),
  };
}

type GuardedAcquisitionOutcome =
  | Readonly<{ status: 'acquired'; claimToken: string; acquisition: ProcessLockAcquisition }>
  | Readonly<{ status: 'busy' | 'unproven'; inspection?: ProcessLockInspection }>;

type StandingClaimJudgment =
  | Readonly<{ kind: 'live'; inspection: ProcessLockInspection }>
  | Readonly<{ kind: 'reclaimable'; owner: ProcessLockOwnerRecord }>
  | Readonly<{ kind: 'none' }>;

/**
 * Judges liveness before the guard is taken. The guard then only confirms that the record it
 * would remove is still the one judged here.
 */
function judgeStandingClaim(ownerFilePath: string): StandingClaimJudgment {
  const reading = readProcessLockOwner(ownerFilePath);
  if (reading.kind !== 'owner') return { kind: 'none' };
  const liveness = classifyOwnerLiveness({ owner: reading.owner });
  if (isLiveOwnerLiveness(liveness) && !isSpentOwnClaim(reading.owner)) {
    const { pid, startTime, acquiredAtMs } = reading.owner;
    return {
      kind: 'live',
      inspection: { state: 'held', owner: { pid, startTime, acquiredAtMs }, liveness },
    };
  }
  return { kind: 'reclaimable', owner: reading.owner };
}

type LockDirectoryReading =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'owner'; owner: ProcessLockOwnerRecord }>
  | Readonly<{ kind: 'unproven'; inspection: ProcessLockInspection }>;

/** Reads the lock path under the guard, where an unwritten record has no publisher to wait for. */
function readLockDirectory(lockDirPath: string, ownerFilePath: string): LockDirectoryReading {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lockDirPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unproven', inspection: { state: 'unproven', reason: 'owner-unreadable' } };
  }
  if (!stats.isDirectory()) {
    return { kind: 'unproven', inspection: { state: 'unproven', reason: 'non-directory' } };
  }
  const reading = readProcessLockOwner(ownerFilePath);
  if (reading.kind === 'owner') return { kind: 'owner', owner: reading.owner };
  const reason = reading.kind === 'unwritten' ? 'owner-unwritten' : 'owner-unreadable';
  return { kind: 'unproven', inspection: { state: 'unproven', reason } };
}

function isSameClaim(left: ProcessLockOwnerRecord, right: ProcessLockOwnerRecord): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.acquiredAtMs === right.acquiredAtMs &&
    left.claimToken === right.claimToken &&
    left.claimIssuerId === right.claimIssuerId
  );
}

export async function acquireProcessLock(
  params: ProcessLockOptions & { timeoutMs?: number; pollMs?: number },
): Promise<ProcessLockRelease> {
  return (await acquireProcessLockAcquisition(params)).release;
}

export async function acquireProcessLockAcquisition(
  params: ProcessLockOptions & { timeoutMs?: number; pollMs?: number },
): Promise<ProcessLockAcquisition> {
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = params.pollMs ?? DEFAULT_LOCK_POLL_MS;
  do {
    const attempt = tryAcquireProcessLock(params);
    if (attempt.status === 'acquired') return attempt.acquisition;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  } while (Date.now() < deadline);
  const reading = readProcessLockOwner(path.join(params.lockDirPath, OWNER_FILE_NAME));
  throw new AppError(
    'COMMAND_FAILED',
    `Timed out waiting for ${params.description ?? 'process lock'}`,
    {
      lockDirPath: params.lockDirPath,
      reason: 'process_lock_timeout',
      ...readProcessLockDiagnostics(params.lockDirPath, reading),
      inspection: inspectProcessLock(params.lockDirPath),
      hint: staleLockHint(params.lockDirPath),
    },
  );
}

function createProcessLockAcquisition(
  params: ProcessLockOptions,
  claim: ProcessLockOwnerRecord,
): ProcessLockAcquisition {
  const { lockDirPath } = params;
  const ownerFilePath = path.join(lockDirPath, OWNER_FILE_NAME);
  let active = true;
  let released = false;
  return Object.freeze({
    assertHeld() {
      if (!active || readClaimOwnership(lockDirPath, claim) !== 'owned') {
        throw new AppError('COMMAND_FAILED', 'Process lock acquisition is no longer held', {
          lockDirPath,
          ownerOwnershipLost: true,
        });
      }
    },
    async release() {
      if (released) return;
      active = false;
      liveClaimTokens.delete(claim.claimToken!);
      const ownership = readClaimOwnership(lockDirPath, claim);
      if (ownership === 'absent' || ownership === 'not-owner') {
        released = true;
        return;
      }
      let outcome: 'removed' | 'not-owner' | 'unverified' = 'unverified';
      if (await waitForReclaimMutex(lockDirPath)) {
        try {
          outcome = releaseProcessLock(lockDirPath, ownerFilePath, claim);
        } finally {
          releaseReclaimMutex(lockDirPath);
        }
      }
      if (outcome !== 'unverified') {
        released = true;
        return;
      }
      emitDiagnostic({
        level: 'warn',
        phase: 'process_lock_release_unverified',
        data: { lockDirPath, description: params.description, ownerReleaseUnverified: true },
      });
      throw new AppError(
        'COMMAND_FAILED',
        `Cannot verify ownership of ${params.description ?? 'process lock'}`,
        {
          lockDirPath,
          ownerReleaseUnverified: true,
          hint: staleLockHint(lockDirPath),
        },
      );
    },
  });
}

function staleLockHint(lockDirPath: string): string {
  return `Restore process inspection or stop the verified owner, then retry. Remove ${lockDirPath} and ${reclaimMutexPath(lockDirPath)} only after confirming all users of this state directory have stopped.`;
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
  const ownership = readClaimOwnership(lockDirPath, claim);
  if (ownership === 'owned') return clearLockDirectory(lockDirPath, ownerFilePath, claim);
  return ownership === 'absent' ? 'removed' : ownership;
}

function readClaimOwnership(
  lockDirPath: string,
  claim: ProcessLockOwnerRecord,
): 'owned' | 'not-owner' | 'absent' | 'unverified' {
  const reading = readProcessLockOwner(path.join(lockDirPath, OWNER_FILE_NAME));
  if (reading.kind === 'unreadable') return 'unverified';
  if (reading.kind === 'unwritten') return fs.existsSync(lockDirPath) ? 'unverified' : 'absent';
  return ownerIdentityMatches(reading.owner, claim) && reading.owner.claimToken === claim.claimToken
    ? 'owned'
    : 'not-owner';
}

/**
 * A lock directory is written by this module and holds one file: its record. So it is emptied
 * and removed rather than removed with everything inside, and a directory that turns out to
 * hold something else is left standing. That distinction is the difference between clearing a
 * lock and destroying whoever put their thing in that path.
 */
function clearLockDirectory(
  lockDirPath: string,
  ownerFilePath: string,
  owner: ProcessLockOwnerRecord,
): 'removed' | 'unverified' {
  try {
    if (fs.readdirSync(lockDirPath).some((entry) => entry !== OWNER_FILE_NAME)) {
      return 'unverified';
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'removed' : 'unverified';
  }
  try {
    fs.unlinkSync(ownerFilePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return 'unverified';
  }
  try {
    fs.rmdirSync(lockDirPath);
    return 'removed';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'removed';
    try {
      publishFileSync({
        destination: ownerFilePath,
        contents: JSON.stringify(owner),
        publish: 'link-exclusive',
      });
    } catch {}
    return 'unverified';
  }
}

function reclaimMutexPath(lockDirPath: string): string {
  const stem = lockDirPath.endsWith(LOCK_DIRECTORY_SUFFIX)
    ? lockDirPath.slice(0, -LOCK_DIRECTORY_SUFFIX.length)
    : lockDirPath;
  return `${stem}${RECLAIM_MUTEX_SUFFIX}${LOCK_DIRECTORY_SUFFIX}`;
}

// Legacy age-based rmdir cannot remove this file, so fresh legacy reclaim admission fails.
function holdReclaimMutex(lockDirPath: string): boolean {
  let descriptor: number;
  try {
    descriptor = fs.openSync(reclaimMutexPath(lockDirPath), 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return false;
  }
  fs.closeSync(descriptor);
  return true;
}

/**
 * A held guard is a short filesystem step in progress, not evidence that ownership was lost, so a
 * release waits for it. Only a guard still held after the bound counts as unverified.
 */
async function waitForReclaimMutex(lockDirPath: string): Promise<boolean> {
  const deadline = Date.now() + RELEASE_GUARD_WAIT_MS;
  while (!holdReclaimMutex(lockDirPath)) {
    if (Date.now() >= deadline) return false;
    await sleep(RELEASE_GUARD_POLL_MS);
  }
  return true;
}

function releaseReclaimMutex(lockDirPath: string): void {
  try {
    fs.unlinkSync(reclaimMutexPath(lockDirPath));
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Process lock mutation guard release could not be confirmed.',
      {
        reason: 'process_lock_guard_release_failed',
        lockDirPath,
        hint: staleLockHint(lockDirPath),
      },
      error,
    );
  }
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
    pid: isProcessPid,
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

function isLiveOwnerLiveness(liveness: OwnerLiveness): boolean {
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
