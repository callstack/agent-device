import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { clearDeviceClaim, type DeviceClaimClearOutcome } from '../device/device-claims.ts';
import { existingSessionExecutionLockKeys } from '../request-binding.ts';
import { withRequestExecutionLockKeys } from '../request-execution-locks.ts';
import type { RequestExecutionLockKey } from '../request-binding.ts';
import {
  buildIdleExpiryTombstone,
  isIdleExpirableSession,
  isSessionIdleExpired,
  lastActivityMs,
  sessionIdleDeadlineMs,
  type SessionIdleExpiryOutcome,
} from '../session-idle-expiry.ts';
import type { SessionState } from '../session-state.ts';
import type { SessionStore } from '../session-store.ts';

/** Settles one expired session's owned resources. Supplied by the runtime, which owns the seams. */
export type IdleSessionSettler = (session: SessionState, sessionName: string) => Promise<void>;

/** The one outcome this reaper invents: the clear threw, so nothing about the claim is known. */
const CLAIM_CLEAR_FAILED = 'claim-clear-failed';

/**
 * Whether an outcome confirms this daemon no longer holds the device. A table rather than a
 * comparison so a member added to `DeviceClaimClearOutcome` cannot default its way into "go ahead
 * and forget the session": a new outcome has to declare itself here.
 */
const CLAIM_GONE: Readonly<Record<DeviceClaimClearOutcome, boolean>> = Object.freeze({
  deleted: true,
  absent: true,
  'ownership-changed': true,
  unattributable: false,
});

/**
 * The largest delay a Node `setTimeout` can express. Anything above it is silently replaced by a
 * 1 ms timer rather than rejected, which would turn a long window into a busy loop.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type SessionIdleExpiryController = Readonly<{
  /**
   * Re-arms the pending expiry from the current session set. Called after anything that can start or
   * end a deadline: a session opened, a session closed, or a command finishing on one. A no-op while
   * the policy is off, so the default configuration schedules nothing at all.
   */
  noteSessionsChanged: () => void;
  /**
   * Stops scheduling and tells a sweep already running to stop starting settles. The composition
   * calls this when the daemon begins to leave; it does not wait for a settle that had already
   * started, because a daemon on its way out must not be held hostage by a teardown that is stuck —
   * the process ending takes the stuck work with it.
   */
  cancel: () => void;
  readonly idleExpiryMs: number;
}>;

/**
 * The #2833 deadline's clock: one timer, always pointing at the earliest deadline in the session set.
 *
 * A timer rather than a lazy check at the next command, because a claim only frees its device once the
 * daemon that took it releases it, and the agent that abandoned the session is by definition the one
 * that stopped sending commands. Another worktree cannot help either: a claim is owned by the daemon
 * that wrote it, so no other process may clear one, and #1320 keeps it that way.
 *
 * Every expiry runs under that session's execution lock pair — the session key AND the device key it
 * is bound to, in the same order a request takes them — and re-checks the deadline inside them. That
 * is what makes the two rules of this feature hold together: an admitted command holds the locks and
 * re-stamps activity when it finishes, so a session in use is never caught mid-command, and the
 * deadline it is measured against is always the one its last finished command set. Settling without
 * the device key would release a device under a command that still holds it, and taking the two keys
 * in any other order would deadlock against a request's pair.
 */
export function createSessionIdleExpiry(params: {
  sessionStore: SessionStore;
  idleExpiryMs: number;
  executionLocks: Map<string, Promise<unknown>>;
  settleSession: IdleSessionSettler;
  /**
   * How long a sweep WAITS on one expiry. Bounds the wait only, never the expiry: the expiry is what
   * holds this session's execution locks, and a budget that took those from under it would let a
   * retried `close` join a teardown in progress. See `expireIdleSession`.
   */
  settleBudgetMs?: (session: SessionState) => number;
  /**
   * Runs one sweep inside whatever diagnostics scope the composition owns. A sweep is out-of-request
   * work, so without it `emitDiagnostic` is a no-op and every reclaim — and every failed reclaim —
   * is unrecordable, following ADR 0018's session-scoped teardown scope.
   */
  withinDiagnosticsScope?: (run: () => Promise<void>) => Promise<void>;
  /**
   * Reports a release that actually landed. Called by the expiry rather than by the sweep's wait, so a
   * release that arrives after its budget elapsed still counts: it freed the device and the session is
   * gone, and a composition that never learns has an idle daemon it believes is still in use.
   */
  onSessionExpired?: (outcome: SessionIdleExpiryOutcome) => void;
  now?: () => number;
}): SessionIdleExpiryController {
  const { sessionStore, idleExpiryMs } = params;
  const now = params.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sweeping = false;
  // `cancel()` is the daemon beginning to leave. It stops future sweeps, and it also tells a sweep
  // already running not to START settling another session: shutdown tears the whole session set down
  // without taking any execution lock, so it is the one remover that can finalize a session out from
  // under a settle. A sweep already inside a settle cannot be recalled, and settles there because
  // stopping mid-teardown would strand a resource; what it must not do is write an idle-expiry
  // marker over a shutdown's close, which `SessionStore.delete`'s answer detects.
  let closing = false;
  // Addresses with a settle in flight. A settle whose budget expired stopped being WAITED on, not
  // stopped: it keeps holding the session's execution lock until it actually finishes. Without this
  // the next sweep would take the lock the moment that budget released and run a second teardown of
  // the same session concurrently with the first.
  const settling = new Set<string>();
  // Sessions whose last settle attempt could not finish, and when the next one may run. A failed
  // settle deliberately leaves the session and its claim in place, so without this the earliest
  // deadline would stay in the past and the timer would refire with zero delay forever. One full
  // window is the retry cadence: it is the only interval this feature is configured to care about.
  const retryNotBeforeMs = new Map<string, number>();

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  /** Called by the composition when this daemon begins to leave. */
  const cancel = (): void => {
    closing = true;
    clearTimer();
  };

  const nextDueMs = (): number | undefined => {
    let next: number | undefined;
    const liveAddresses = new Set<string>();
    for (const ref of sessionStore.listRefs()) {
      liveAddresses.add(ref.address);
      const deadline = sessionIdleDeadlineMs(ref.session, idleExpiryMs);
      if (deadline === undefined) continue;
      const notBefore = retryNotBeforeMs.get(ref.address);
      const due = notBefore === undefined ? deadline : Math.max(deadline, notBefore);
      if (next === undefined || due < next) next = due;
    }
    // A session that left the store has nothing left to retry, and `close` never reaches the expiry
    // that would have cleared it. An address re-created by `open` can inherit a deferral its new
    // occupant never earned, and that costs at most one window: a fresh record's own deadline is a
    // full window ahead anyway, so an inherited deferral never reaches past the one it was set for.
    for (const address of retryNotBeforeMs.keys()) {
      if (!liveAddresses.has(address)) retryNotBeforeMs.delete(address);
    }
    return next;
  };

  const arm = (): void => {
    clearTimer();
    if (closing || idleExpiryMs <= 0 || sweeping) return;
    const atMs = now();
    const deadline = nextDueMs();
    if (deadline === undefined) return;
    const waitMs = Math.max(0, deadline - atMs);
    // A Node timer cannot express anything past a signed 32-bit int: the delay is silently replaced
    // by 1 ms rather than rejected. A window longer than ~24.8 days — which `resolveSessionIdleExpiryMs`
    // accepts, because off is spelled `0` and a huge value is a real reading of "essentially never" —
    // would therefore arm a sweep every millisecond, and each sweep would find the session inside its
    // window and re-arm at the same 1 ms. So a wait beyond the range is taken in pieces, and a piece
    // that ends with the deadline still ahead simply re-arms instead of sweeping.
    const deadlineStillAheadOfThisPiece = waitMs > MAX_TIMER_DELAY_MS;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (deadlineStillAheadOfThisPiece) arm();
        else void runSweep();
      },
      Math.min(waitMs, MAX_TIMER_DELAY_MS),
    );
    // An armed reaper must never be what keeps a daemon's event loop alive: the daemon has its own
    // lifetime rules (idle reap, lock, signal handlers) and this only frees a device sooner.
    timer.unref?.();
  };

  const runSweep = async (): Promise<void> => {
    sweeping = true;
    const sweep = async (): Promise<void> => {
      try {
        await expireIdleSessions({
          ...params,
          now,
          retryNotBeforeMs,
          settling,
          closing: () => closing,
          notifyExpired: params.onSessionExpired,
        });
      } catch (error) {
        // A sweep is never allowed to reject into the daemon's unhandled-rejection path: that path
        // shuts the daemon down, and a failed reclaim must not cost every other session its daemon.
        emitDiagnostic({
          level: 'warn',
          phase: 'session_idle_expiry_sweep_failed',
          data: { idleExpiryMs, error: error instanceof Error ? error.message : String(error) },
        });
      }
    };
    try {
      await (params.withinDiagnosticsScope ? params.withinDiagnosticsScope(sweep) : sweep());
    } finally {
      sweeping = false;
      arm();
    }
  };

  return { noteSessionsChanged: arm, cancel, idleExpiryMs };
}

type IdleExpirySweepParams = {
  sessionStore: SessionStore;
  idleExpiryMs: number;
  executionLocks: Map<string, Promise<unknown>>;
  settleSession: IdleSessionSettler;
  /**
   * How long a sweep waits for one expiry. Optional because the composition owns the teardown budget.
   * Bounds the wait only, never the expiry itself — see `expireIdleSession`.
   */
  settleBudgetMs?: (session: SessionState) => number;
  /**
   * Reports a release that actually landed. Called by the expiry rather than by the sweep's wait, so a
   * release that arrives after its budget elapsed still counts: it freed the device and the session is
   * gone, and a composition that never learns has an idle daemon it believes is still in use.
   */
  notifyExpired?: (outcome: SessionIdleExpiryOutcome) => void;
  now: () => number;
  retryNotBeforeMs: Map<string, number>;
  settling: Set<string>;
  closing: () => boolean;
};

async function expireIdleSessions(params: IdleExpirySweepParams): Promise<void> {
  for (const ref of params.sessionStore.listRefs()) {
    if (!isIdleExpirableSession(ref.session)) continue;
    // Shutdown is tearing every session down without taking a single execution lock, so a settle
    // started now would only race it.
    if (params.closing()) return;
    await expireIdleSession({ ...params, ref });
  }
}

/**
 * Starts one expiry and waits for it as long as the budget allows.
 *
 * The budget bounds only this WAIT, never the expiry. The expiry is what holds the session's and the
 * device's execution locks and what may free the device; detaching the wait is what keeps one stuck
 * recorder from hanging a sweep, while keeping the locks with the expiry is what stops a budget from
 * letting a `close` tear the same session down twice or letting a late release delete a session a
 * retried `open` just created. Reporting belongs to the expiry rather than to this wait, so a release
 * that lands after the budget still counts.
 */
async function expireIdleSession(
  params: IdleExpirySweepParams & { ref: { address: string; session: SessionState } },
): Promise<void> {
  const { address } = params.ref;
  // A release still in flight holds this session's locks, so queueing on them would have the sweep wait
  // for a stuck teardown instead of getting on with the rest of the session set. Skipping is only
  // correct because it defers this address in the same breath: the deadline is still in the past, and a
  // sweep that re-arms at a past deadline fires again the instant it is armed — a stuck release would
  // then spin the event loop for its whole duration. One window is the same cadence a failed settle
  // already asks for, and the release in flight sets its own retry clock when it finishes.
  if (params.settling.has(address)) {
    params.retryNotBeforeMs.set(address, params.now() + params.idleExpiryMs);
    return;
  }
  // The device this expiry fences is read inside the lock pair rather than from the swept reference:
  // a session can only change device while its own session lock is free, which this pair holds first.
  // The pair comes from the same planner a command on this session uses, so the device key is what
  // stops an expiry releasing a device another session's command still holds, and the order is what
  // stops it deadlocking against a request holding the other one.
  const lockKeys = existingSessionExecutionLockKeys(address, params.ref.session.device.id);
  const expiry = settleIdleSessionUnderLock({ ...params, lockKeys });
  const budgetMs = params.settleBudgetMs?.(params.ref.session);
  if (budgetMs === undefined) return void (await expiry);
  const budget = budgetElapsedAfter(budgetMs);
  try {
    if ((await Promise.race([expiry, budget.promise])) !== BUDGET_ELAPSED) return;
  } finally {
    budget.cancel();
  }
  emitDiagnostic({
    level: 'warn',
    phase: 'session_idle_expiry_settle_timeout',
    data: {
      session: address,
      idleExpiryMs: params.idleExpiryMs,
      settleBudgetMs: budgetMs,
      ...(params.ref.session.deviceClaim
        ? { deviceKey: params.ref.session.deviceClaim.deviceKey }
        : {}),
    },
  });
  // Deferred rather than cleared: the release is still running and may yet succeed, in which case the
  // session disappears and the next sweep prunes this entry along with it. Measured from here — the
  // moment this sweep stopped waiting — because the release may have been running for most of the
  // window already, and deferring from when it STARTED would schedule the next pass in the past.
  params.retryNotBeforeMs.set(address, params.now() + params.idleExpiryMs);
}

const BUDGET_ELAPSED = Symbol('session-idle-settle-budget-elapsed');

/**
 * A wait the expiry can win. Unref'd and cancellable because a sweep that stopped waiting must leave
 * nothing behind: a ref'd timer here is a daemon that cannot exit, and an armed one is a timer the
 * event loop carries for the whole budget after the session it was watching was released.
 */
function budgetElapsedAfter(ms: number): Readonly<{
  promise: Promise<typeof BUDGET_ELAPSED>;
  cancel: () => void;
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof BUDGET_ELAPSED>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_ELAPSED), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Runs one expiry from start to finish INSIDE the session's and the device's execution lock pair, and
 * reports its outcome whether or not anyone is still waiting for it.
 *
 * The lock pair outlives the sweep's wait on purpose. A budget that released these locks would let a
 * retried `close` join a teardown already in progress, and let the expiry's own final steps — delete
 * this record, write the marker — land on a session a fresh `open` had just created at this address,
 * orphaning that new session's claim. The `settling` fence spans the same span so no second expiry
 * queues behind the first either, and lifts only when the release is genuinely over.
 */
async function settleIdleSessionUnderLock(
  params: IdleExpirySweepParams & {
    ref: { address: string; session: SessionState };
    lockKeys: readonly RequestExecutionLockKey[];
  },
): Promise<SessionIdleExpiryOutcome | undefined> {
  const { address, session } = params.ref;
  params.settling.add(address);
  let attempt: IdleSettleAttempt;
  try {
    attempt = await withRequestExecutionLockKeys(
      params.executionLocks,
      params.lockKeys,
      async () => {
        // Re-checked inside the pair: a settle that took this lock before `cancel()` can still be
        // finishing its resources while shutdown runs, and a queued one must not begin then.
        if (params.closing()) return NOTHING_TO_RETRY;
        // Re-read under the locks rather than trusting the swept reference: the device may have moved,
        // and the lock keys were chosen from the pre-lock reading.
        const settled = params.sessionStore.get(address);
        if (!settled) return NOTHING_TO_RETRY;
        if (settled.device.id !== session.device.id) return NOTHING_TO_RETRY;
        // Re-clocked here too: a command that admitted while this expiry was queuing has finished and
        // re-stamped the session by now, so a deadline seen outside the locks is a hint, not a verdict.
        const atMs = params.now();
        if (!isSessionIdleExpired(settled, params.idleExpiryMs, atMs)) return NOTHING_TO_RETRY;
        const outcome = await settleExpiredSession({
          sessionName: address,
          session: settled,
          idleExpiryMs: params.idleExpiryMs,
          expiredAtMs: atMs,
          sessionStore: params.sessionStore,
          settleSession: params.settleSession,
        });
        return { outcome, retry: true };
      },
    );
    if (attempt.retry) {
      rememberRetry(params, address, attempt.outcome);
    } else {
      // A session that is gone, moved, or back inside its window earned no deferral: it is the next
      // command or the next deadline that decides what happens here, not a clock this sweep set.
      params.retryNotBeforeMs.delete(address);
    }
  } catch (error) {
    // The rejection is owned here: a budget that stopped waiting would otherwise hand the failure to
    // the daemon's `unhandledRejection` handler, which spends a live daemon on one stuck recorder.
    emitDiagnostic({
      level: 'warn',
      phase: 'session_idle_expiry_settle_failed',
      data: {
        session: address,
        idleExpiryMs: params.idleExpiryMs,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    rememberRetry(params, address, undefined);
    return undefined;
  } finally {
    params.settling.delete(address);
  }
  if (attempt.outcome) params.notifyExpired?.(attempt.outcome);
  return attempt.outcome;
}

/** Whether a pass under the locks has anything to retry, and what it achieved if it has. */
type IdleSettleAttempt = Readonly<{
  outcome: SessionIdleExpiryOutcome | undefined;
  retry: boolean;
}>;

/**
 * A pass that decided not to settle — the session closed, moved to another device, or is back inside
 * its window. Only an expiry that actually ran and could not finish is owed a retry clock.
 */
const NOTHING_TO_RETRY: IdleSettleAttempt = Object.freeze({ outcome: undefined, retry: false });

/**
 * Gives an expiry that ran and could not finish a full window before the next attempt, and takes the
 * deferral away from one that succeeded. Measured from NOW, at the moment the attempt ends, rather
 * than from when the sweep started it: a release is bounded only in how long anyone waits for it, so
 * one that outlasts the window would otherwise write a deferral already in the past and be retried
 * with no gap at all — and would overwrite the fresher deferral a sweep that found it in flight had
 * just computed for the same address.
 */
function rememberRetry(
  params: Pick<IdleExpirySweepParams, 'retryNotBeforeMs' | 'now' | 'idleExpiryMs'>,
  address: string,
  outcome: SessionIdleExpiryOutcome | undefined,
): void {
  if (outcome) {
    params.retryNotBeforeMs.delete(address);
    return;
  }
  params.retryNotBeforeMs.set(address, params.now() + params.idleExpiryMs);
}

/**
 * Settles one expired session: its owned resources, then its claim, then the repair transaction it
 * ends, then its record, then the bounded marker that tells the next command what happened.
 *
 * The order matters three times over. The claim has to outlive the resource teardown, because a claim
 * whose device still has an attached helper or a live execution host describes an unfinished release
 * rather than a free device — the same rule `close` follows when it withholds the clear after a failed
 * teardown. Repair finalization has to wait for the claim, because committing is one-way and a settle
 * that is held back must leave the transaction committable by the pass that succeeds. And the marker is
 * written once the session record is gone, because it is a diagnostic for the agent that comes next,
 * never a reason to skip cleanup.
 *
 * A failed settle returns `undefined` and changes nothing, not even the session record. This daemon is
 * staying alive, so it can retry; deleting the session anyway would leave a claim owned by a live
 * process that no longer knows what it holds — un-reclaimable by `--stale`, which proves staleness
 * from the owner's liveness, and strictly worse than not expiring at all. That argument binds the
 * clear itself as hard as it binds the teardown: a clear that learned nothing — it threw, or left a
 * record no owner can be attributed to — leaves the same stranded claim, so it holds the record back
 * too and the next pass tries again. A clear reporting `ownership-changed` is confirmation that a
 * successor owns the device now, and never blocks the expiry.
 */
async function settleExpiredSession(params: {
  sessionName: string;
  session: SessionState;
  idleExpiryMs: number;
  expiredAtMs: number;
  sessionStore: SessionStore;
  settleSession: IdleSessionSettler;
}): Promise<SessionIdleExpiryOutcome | undefined> {
  const { sessionName, session, idleExpiryMs, expiredAtMs } = params;
  const deviceKey = session.deviceClaim?.deviceKey;
  const identity = { session: sessionName, idleExpiryMs, ...(deviceKey ? { deviceKey } : {}) };
  if (!(await releaseExpiredSessionResources(params, identity))) return undefined;
  const claim = await clearExpiredClaim(sessionName, session.deviceClaim);
  if (claim === CLAIM_CLEAR_FAILED || !CLAIM_GONE[claim]) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_idle_expiry_device_claim_unconfirmed',
      data: identity,
    });
    return undefined;
  }
  // ADR 0012 R7 binds an expiry like every other teardown: a repair transaction this expiry catches
  // commits its healed `.ad` iff COMPLETE and otherwise leaves its own tombstone, which the router
  // already prefers over the idle-expiry marker's guidance. It runs AFTER the gate above rather than
  // inside the settler, because publishing is part of ending the session: `finalizeRepairTeardown`
  // stamps COMMITTED onto the record, and a write onto an already-committed transaction is an
  // idempotent no-op. Finalizing a settle that is being held back would therefore mark a still-live
  // session's healed script as already published, and no later teardown would ever publish it.
  params.sessionStore.finalizeRepairTeardown(session);
  // `delete` reports whether a record was still here to remove. The usual request-path removers —
  // `close`, a replacing `open`, a lease-expiry teardown — all remove a session from inside
  // `runAdmitted`, which holds the same lock pair this settle holds, so they cannot get here first
  // while the wait is still ours. Two callers can: daemon shutdown, which tears the session set down
  // taking no lock at all, and any of those three after a settle budget already released this lock and
  // left the task running unheld. Either way the session was ended by someone else, and that owner
  // has already explained it. Writing a marker here would tell the next agent the session died of
  // idleness when something else closed it.
  if (!params.sessionStore.delete(sessionName)) {
    emitDiagnostic({
      level: 'info',
      phase: 'session_idle_expiry_superseded',
      data: identity,
    });
    return undefined;
  }
  // The marker is keyed by the store address: the one string that both names this session's artifact
  // directory correctly and resolves back to this same session for the next command. Keying it by
  // `session.name` would let two worktrees' `default` sessions overwrite each other's marker.
  params.sessionStore.writeIdleExpiryTombstone(
    sessionName,
    buildIdleExpiryTombstone(sessionName, { expiredAtMs, idleExpiryMs, deviceKey }),
  );
  const idleForMs = expiredAtMs - lastActivityMs(session);
  emitDiagnostic({
    level: 'info',
    phase: 'session_idle_expired',
    data: { ...identity, idleForMs, claim },
  });
  return {
    sessionName,
    idleExpiryMs,
    idleForMs,
    claim,
    ...(deviceKey ? { deviceKey } : {}),
  };
}

/**
 * Releases one expired session's owned resources, reporting whether the settle may proceed to the
 * claim. A failure here is reported and swallowed rather than propagated: the caller's answer is the
 * same either way — hold the record back and retry — and the distinguishing information belongs to
 * this step's diagnostic.
 */
async function releaseExpiredSessionResources(
  params: { session: SessionState; sessionName: string; settleSession: IdleSessionSettler },
  identity: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  try {
    await params.settleSession(params.session, params.sessionName);
    return true;
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_idle_expiry_cleanup_failed',
      data: { ...identity, error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}

/**
 * Releases the expired session's own claim. Two results say this daemon learned nothing about
 * whether its claim is gone — the clear threw, and `unattributable`, where a record is still on disk
 * that yields no attributable owner. Both hold the session record back: forgetting it would leave a
 * claim owned by a live process that no longer knows what it holds, which `device release --stale`
 * cannot reclaim because it proves staleness from the owner's liveness.
 */
async function clearExpiredClaim(
  sessionName: string,
  ownership: SessionState['deviceClaim'],
): Promise<DeviceClaimClearOutcome | typeof CLAIM_CLEAR_FAILED> {
  if (!ownership) return 'absent';
  try {
    return await clearDeviceClaim(ownership);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_idle_expiry_device_claim_clear_failed',
      data: {
        session: sessionName,
        deviceKey: ownership.deviceKey,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return CLAIM_CLEAR_FAILED;
  }
}
