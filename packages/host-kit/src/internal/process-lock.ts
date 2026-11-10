import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, normalizeError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { publishFileSync } from './atomic-file.ts';
import { emitDiagnostic } from './diagnostics.ts';
import {
  isProcessAlive,
  readHostProcessIdentityObservations,
  readHostProcessIdentityObservationsAsync,
  type HostProcessIdentityObservation,
} from './host-process.ts';
import {
  classifyOwnerLiveness,
  classifyOwnerLivenessAsync,
  classifyOwnerLivenessFromObservation,
  isProcessPid,
  ownerIdentityMatches,
  readCurrentOwnerIdentity,
  readCurrentOwnerIdentityAsync,
  type OwnerLiveness,
} from './owner-identity.ts';
import { sleep } from './retry.ts';

const OWNER_FILE_NAME = 'owner.json';
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;
const LOCK_DIRECTORY_SUFFIX = '.lock';
const RECLAIM_MUTEX_SUFFIX = '.reclaim';
const RELEASE_GUARD_WAIT_MS = 5_000;
const RELEASE_GUARD_POLL_MS = 5;
// A waiter re-reads the owner's process identity at most this often for the same claim. Liveness is
// still re-proven with `kill(pid, 0)` on every poll, so a reused observation only delays a reclaim.
const OWNER_OBSERVATION_REUSE_MS = 1_000;
// A guard is held for a few filesystem calls. One standing longer than this is worth a process-table
// read of its holder; age only spends that read and never proves the holder gone.
const GUARD_HOLDER_PROBE_AFTER_MS = 1_000;
const GUARD_REAP_MARKER_SUFFIX = '.reap';

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
  return inspectProcessLockWith(lockDirPath, (owner) => classifyOwnerLiveness({ owner }));
}

function inspectProcessLockWith(
  lockDirPath: string,
  judgeOwner: (owner: ProcessLockOwnerRecord) => OwnerLiveness,
): ProcessLockInspection {
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
    liveness: judgeOwner(reading.owner),
  };
}

/**
 * Makes one attempt. Publication, reclaim and release share a non-expiring mutation guard.
 * All users of this path must use this protocol. Drain legacy users before upgrading and
 * prevent them from returning: a guard cannot revoke a legacy reclaimer already admitted.
 * See docs/adr/0030-process-lock-exclusion.md for the migration contract.
 */
export function tryAcquireProcessLock(params: ProcessLockOptions): ProcessLockAttempt {
  fs.mkdirSync(path.dirname(params.lockDirPath), { recursive: true });
  const reading = readProcessLockOwner(path.join(params.lockDirPath, OWNER_FILE_NAME));
  const liveness =
    reading.kind === 'owner' ? classifyOwnerLiveness({ owner: reading.owner }) : undefined;
  return attemptProcessLock(params, {
    standing: judgeStandingClaim(reading, liveness),
    judgeOwner: (owner) => classifyOwnerLiveness({ owner }),
    abandonedGuard: findAbandonedGuard(
      params.lockDirPath,
      (holder) => readHostProcessIdentityObservations([holder.pid]).get(holder.pid) ?? null,
    ),
    guardHolderStartTime: readCurrentOwnerIdentity().startTime,
  });
}

/** What a contender judged before it made an attempt, with every process probe already spent. */
type AttemptEvidence = Readonly<{
  standing: StandingClaimJudgment;
  /** Judges an owner record the attempt reports on; it must not probe on an async path. */
  judgeOwner: (owner: ProcessLockOwnerRecord) => OwnerLiveness;
  abandonedGuard: AbandonedGuard | undefined;
  /** This process's start time, recorded in a guard it takes. */
  guardHolderStartTime: string | null;
}>;

function attemptProcessLock(
  params: ProcessLockOptions,
  evidence: AttemptEvidence,
): ProcessLockAttempt {
  const { lockDirPath } = params;
  const judgment = evidence.standing;
  if (judgment.kind === 'live') return { status: 'busy', inspection: judgment.inspection };
  if (!holdReclaimMutex(lockDirPath, evidence.abandonedGuard, evidence.guardHolderStartTime)) {
    return { status: 'busy', inspection: inspectProcessLockWith(lockDirPath, evidence.judgeOwner) };
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
    inspection: outcome.inspection ?? inspectProcessLockWith(lockDirPath, evidence.judgeOwner),
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
function judgeStandingClaim(
  reading: ProcessLockOwnerReading,
  liveness: OwnerLiveness | undefined,
): StandingClaimJudgment {
  if (reading.kind !== 'owner' || liveness === undefined) return { kind: 'none' };
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
  params: ProcessLockOptions & { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<ProcessLockRelease> {
  return (await acquireProcessLockAcquisition(params)).release;
}

export async function acquireProcessLockAcquisition(
  params: ProcessLockOptions & { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<ProcessLockAcquisition> {
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = params.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const ownerFilePath = path.join(params.lockDirPath, OWNER_FILE_NAME);
  const observedOwner = createOwnerObservationReuse();
  const observedGuardHolder = createGuardHolderObservationReuse();
  if (params.signal?.aborted) throw createRequestCanceledError();
  const guardHolderStartTime = (await readCurrentOwnerIdentityAsync()).startTime;
  fs.mkdirSync(path.dirname(params.lockDirPath), { recursive: true });
  do {
    if (params.signal?.aborted) throw createRequestCanceledError();
    // Every process probe a wait spends runs off the event loop, before the synchronous attempt.
    const reading = readProcessLockOwner(ownerFilePath);
    const liveness =
      reading.kind === 'owner' ? await observedOwner.classify(reading.owner) : undefined;
    const abandonedGuard = await findAbandonedGuardAsync(params.lockDirPath, observedGuardHolder);
    const attempt = attemptProcessLock(params, {
      standing: judgeStandingClaim(reading, liveness),
      // A record that changed since it was judged is reported without a fresh probe.
      judgeOwner: (owner) =>
        reading.kind === 'owner' && liveness && isSameClaim(owner, reading.owner)
          ? liveness
          : 'unknown',
      abandonedGuard,
      guardHolderStartTime,
    });
    if (attempt.status === 'acquired') return attempt.acquisition;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining), params.signal);
    if (params.signal?.aborted) throw createRequestCanceledError();
  } while (Date.now() < deadline);
  const reading = readProcessLockOwner(ownerFilePath);
  const ownerLiveness =
    reading.kind === 'owner'
      ? await classifyOwnerLivenessAsync({ owner: reading.owner })
      : undefined;
  const judgeOwner = (owner: ProcessLockOwnerRecord): OwnerLiveness =>
    reading.kind === 'owner' && ownerLiveness && isSameClaim(owner, reading.owner)
      ? ownerLiveness
      : 'unknown';
  throw new AppError(
    'COMMAND_FAILED',
    `Timed out waiting for ${params.description ?? 'process lock'}`,
    {
      lockDirPath: params.lockDirPath,
      reason: 'process_lock_timeout',
      ...readProcessLockDiagnostics(params.lockDirPath, reading, ownerLiveness),
      inspection: inspectProcessLockWith(params.lockDirPath, judgeOwner),
      hint: staleLockHint(params.lockDirPath),
    },
  );
}

/**
 * Judges a waited-on owner off the event loop, reading its process identity at most once per
 * {@link OWNER_OBSERVATION_REUSE_MS} for the same claim. The reused observation can only keep a
 * live verdict a little longer: death is re-proven by `kill(pid, 0)` on every call, and a zombie or
 * a contradicted start time stays true of the recorded process however old the observation is.
 */
function createOwnerObservationReuse() {
  let reused:
    | Readonly<{
        owner: ProcessLockOwnerRecord;
        observation: HostProcessIdentityObservation | null;
        atMs: number;
      }>
    | undefined;
  return {
    async classify(owner: ProcessLockOwnerRecord): Promise<OwnerLiveness> {
      const fresh =
        reused !== undefined &&
        isSameClaim(reused.owner, owner) &&
        Date.now() - reused.atMs < OWNER_OBSERVATION_REUSE_MS;
      if (!fresh && isProcessPid(owner.pid) && isProcessAlive(owner.pid)) {
        const observations = await readHostProcessIdentityObservationsAsync([owner.pid]);
        reused = { owner, observation: observations.get(owner.pid) ?? null, atMs: Date.now() };
      }
      const observation = reused && isSameClaim(reused.owner, owner) ? reused.observation : null;
      return classifyOwnerLivenessFromObservation({ owner }, observation);
    },
  };
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

/**
 * The guard's holder, written into the guard file itself. A holder that dies inside its guarded
 * filesystem step would otherwise leave a guard nobody can attribute, and so nobody can remove.
 */
type GuardHolder = Readonly<{ pid: number; startTime: string | null; token: string }>;

/** A standing guard whose holder is proven dead or its pid reused, named by the holder's token. */
type AbandonedGuard = Readonly<{ token: string }>;

const GUARD_TOKEN = /^[0-9a-f-]{36}$/;

/**
 * Takes the guard. A guard the caller already proved abandoned is reaped first, and only that one:
 * see {@link reapAbandonedGuard}. Legacy age-based rmdir cannot remove this file, so fresh legacy
 * reclaim admission fails.
 */
function holdReclaimMutex(
  lockDirPath: string,
  abandoned: AbandonedGuard | undefined,
  holderStartTime: string | null,
): boolean {
  if (createReclaimMutex(lockDirPath, holderStartTime)) return true;
  if (!abandoned || !reapAbandonedGuard(lockDirPath, abandoned)) return false;
  return createReclaimMutex(lockDirPath, holderStartTime);
}

function createReclaimMutex(lockDirPath: string, holderStartTime: string | null): boolean {
  const mutexPath = reclaimMutexPath(lockDirPath);
  const holder: GuardHolder = {
    pid: process.pid,
    startTime: holderStartTime,
    token: crypto.randomUUID(),
  };
  let descriptor: number;
  try {
    descriptor = fs.openSync(mutexPath, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return false;
  }
  try {
    fs.writeSync(descriptor, JSON.stringify(holder));
  } catch (error) {
    fs.closeSync(descriptor);
    fs.unlinkSync(mutexPath);
    throw error;
  }
  fs.closeSync(descriptor);
  return true;
}

/**
 * Removes a guard whose holder was proven gone, and never a successor's guard. The proof names the
 * holder's token, and only a reaper of that token may remove that guard: the reap marker for a token
 * is created exclusively, so two contenders that judged the same holder dead cannot both act, and a
 * guard re-read under the marker that names another token is left alone. The dead holder cannot
 * remove or replace its own guard, so the record cannot change between that re-read and the unlink.
 */
function reapAbandonedGuard(lockDirPath: string, abandoned: AbandonedGuard): boolean {
  const mutexPath = reclaimMutexPath(lockDirPath);
  const markerPath = `${mutexPath}.${abandoned.token}${GUARD_REAP_MARKER_SUFFIX}`;
  try {
    fs.closeSync(fs.openSync(markerPath, 'wx', 0o600));
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return false;
  }
  try {
    const current = readGuardHolder(mutexPath);
    if (current?.holder.token !== abandoned.token) return false;
    try {
      fs.unlinkSync(mutexPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    emitDiagnostic({
      level: 'warn',
      phase: 'process_lock_guard_reclaimed',
      data: { lockDirPath, holderPid: current.holder.pid },
    });
    return true;
  } finally {
    fs.rmSync(markerPath, { force: true });
  }
}

function readGuardHolder(mutexPath: string): { holder: GuardHolder; ageMs: number } | undefined {
  let contents: string;
  let ageMs: number;
  try {
    contents = fs.readFileSync(mutexPath, 'utf8');
    ageMs = Date.now() - fs.statSync(mutexPath).mtimeMs;
  } catch {
    // Absent, a legacy directory guard, or unreadable: nothing here names a holder to judge.
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!isProcessPid(record.pid) || typeof record.token !== 'string') return undefined;
  if (!GUARD_TOKEN.test(record.token)) return undefined;
  if (record.startTime !== null && typeof record.startTime !== 'string') return undefined;
  return {
    holder: { pid: record.pid, startTime: record.startTime, token: record.token },
    ageMs,
  };
}

/**
 * The standing guard when its holder is provably gone, by the main lock's proof rule: a dead pid, a
 * zombie, or a start time the host contradicts. A guard this process wrote, an unattributable guard,
 * and a holder the host will not describe all stay retained. `kill(pid, 0)` answers a dead holder for
 * free; a live pid is probed only once its guard has stood far longer than any guarded step takes.
 */
function findAbandonedGuard(
  lockDirPath: string,
  observe: (holder: GuardHolder) => HostProcessIdentityObservation | null,
): AbandonedGuard | undefined {
  const standing = readGuardHolder(reclaimMutexPath(lockDirPath));
  if (!standing || standing.holder.pid === process.pid) return undefined;
  const { holder, ageMs } = standing;
  const alive = isProcessAlive(holder.pid);
  if (alive && ageMs < GUARD_HOLDER_PROBE_AFTER_MS) return undefined;
  const observation = alive ? observe(holder) : null;
  return isGoneOwner(classifyOwnerLivenessFromObservation({ owner: holder }, observation))
    ? { token: holder.token }
    : undefined;
}

async function findAbandonedGuardAsync(
  lockDirPath: string,
  observedHolder: GuardHolderObservationReuse,
): Promise<AbandonedGuard | undefined> {
  const standing = readGuardHolder(reclaimMutexPath(lockDirPath));
  if (!standing) return undefined;
  const probed =
    standing.holder.pid !== process.pid &&
    standing.ageMs >= GUARD_HOLDER_PROBE_AFTER_MS &&
    isProcessAlive(standing.holder.pid);
  const observation = probed ? await observedHolder.observe(standing.holder) : null;
  return findAbandonedGuard(lockDirPath, (holder) =>
    holder.token === standing.holder.token ? observation : null,
  );
}

type GuardHolderObservationReuse = ReturnType<typeof createGuardHolderObservationReuse>;

/**
 * Reads a guard holder's process identity at most once per {@link OWNER_OBSERVATION_REUSE_MS} for
 * the same guard token, by the same rule as {@link createOwnerObservationReuse}: a reused
 * observation can only keep a guard retained a little longer, never reap a live holder's guard.
 */
function createGuardHolderObservationReuse() {
  let reused:
    | Readonly<{ token: string; observation: HostProcessIdentityObservation | null; atMs: number }>
    | undefined;
  return {
    async observe(holder: GuardHolder): Promise<HostProcessIdentityObservation | null> {
      if (reused?.token === holder.token && Date.now() - reused.atMs < OWNER_OBSERVATION_REUSE_MS) {
        return reused.observation;
      }
      const observations = await readHostProcessIdentityObservationsAsync([holder.pid]);
      reused = {
        token: holder.token,
        observation: observations.get(holder.pid) ?? null,
        atMs: Date.now(),
      };
      return reused.observation;
    },
  };
}

/**
 * A held guard is a short filesystem step in progress, not evidence that ownership was lost, so a
 * release waits for it. Only a guard still held after the bound counts as unverified.
 */
async function waitForReclaimMutex(lockDirPath: string): Promise<boolean> {
  const deadline = Date.now() + RELEASE_GUARD_WAIT_MS;
  const holderStartTime = (await readCurrentOwnerIdentityAsync()).startTime;
  const observedHolder = createGuardHolderObservationReuse();
  while (
    !holdReclaimMutex(
      lockDirPath,
      await findAbandonedGuardAsync(lockDirPath, observedHolder),
      holderStartTime,
    )
  ) {
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
  ownerLiveness: OwnerLiveness | undefined,
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
          ownerLiveness,
        }
      : reading.kind === 'unreadable'
        ? { ownerRecordUnreadable: true }
        : {}),
  };
}

function isLiveOwnerLiveness(liveness: OwnerLiveness): boolean {
  return !isGoneOwner(liveness);
}

function isGoneOwner(liveness: OwnerLiveness): boolean {
  return liveness === 'owner-process-dead' || liveness === 'owner-process-reused';
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
