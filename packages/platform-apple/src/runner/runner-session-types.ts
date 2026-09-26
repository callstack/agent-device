import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import type { ExecResult } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerXctestrunArtifact } from './runner-xctestrun.ts';
import type { RunnerLease } from './runner-lease.ts';
import type { IosRunnerDeviceStates } from './runner-error-classification.ts';

/**
 * Where one runner process stands in the lifecycle of the session that owns it (#2662). The state
 * records what the runner has proved about itself. Whether its process is still there is a
 * separate fact, answered only by the `isProcessAlive` probe on the runner host; no state here
 * claims that fact.
 *
 * - `starting`: registered and launched, no runner response read yet. A command sent now queues
 *   behind the connection probe, so the session cannot be used.
 * - `ready`: the runner answered a command, so its HTTP channel works. The process can still die
 *   afterwards, which is why usability is read separately.
 * - `draining`: disposal began. The lease is still held and the process is still being signalled,
 *   so the runner can still answer, but the session must not be chosen for new work.
 * - `stopped`: this session's disposable resources settled, or its ownership was handed to
 *   another daemon. Nothing is routed to it again, and a `stopped` session is never revived.
 */
export type RunnerSessionState = 'starting' | 'ready' | 'draining' | 'stopped';

/** The part of a runner session that its lifecycle state machine reads and writes. */
export type RunnerSessionStateHolder = { state: RunnerSessionState };

/**
 * A device's runner across both axes at once (#2662): `starting`, `draining` and `stopped` are the
 * session's own {@link RunnerSessionState}, `gone` is the answer when nothing is registered for the
 * device at all, and `ready` is the only state where a command issued now is answered without
 * waiting on a startup. Three reads used to answer this question by combining a boolean and a
 * process probe three different ways; this is the one type that combines them.
 */
export type RunnerSessionLiveness = RunnerSessionState | 'gone';

/** What is registered for a device, read through the lifecycle lens. */
export type RunnerSessionRegistration = Readonly<{
  sessionId: string;
  liveness: RunnerSessionLiveness;
}>;

// The runner process seen through the session: pid for liveness/kill-tree and
// exitCode for early-exit detection. A spawned ChildProcess satisfies this
// structurally; adopted runners (whose spawner died) provide a pid-backed
// surrogate — which is why the session must not assume streams or kill() here.
export type RunnerProcessHandle = {
  pid?: number | undefined;
  exitCode: number | null;
};

export type RunnerSession = {
  sessionId: string;
  device: DeviceInfo;
  deviceId: string;
  port: number;
  xctestrunPath: string;
  xctestrunArtifact?: RunnerXctestrunArtifact;
  jsonPath: string;
  /**
   * Where this runner's own output goes: the file handed to the child as its stdout/stderr, which
   * the runner keeps appending to across a daemon handoff (#2681). A session adopted from an older
   * lease has none, because that runner wrote into pipes its own daemon held.
   */
  runnerLogPath?: string;
  testPromise: Promise<ExecResult>;
  child: RunnerProcessHandle;
  /**
   * Gives up this daemon's sides of the runner's log: the tail it follows and its copy of the log's
   * write end. Only a session this process launched has either. The runner keeps its own descriptor,
   * so handing off is a bookkeeping step and cannot disturb a running runner (#2681).
   */
  endOutputObservation?: () => void;
  /**
   * Reads the end of {@link runnerLogPath}. The module that opened the file answers for it, so the
   * code quoting a runner's failure does not have to know how the log is stored (#2681).
   */
  readLogTail?: (maxBytes: number) => string;
  /** Moves only through {@link advanceRunnerSessionState}. */
  state: RunnerSessionState;
  /** Wakes one startup retry when the listener becomes ready or its process exits. */
  startupRetryWake?: AbortSignal;
  startupTimeoutMs?: number;
  /**
   * The exchanges this process sent this runner and has not seen answered, and which of them it gave
   * up on. The session owns the one instance; command paths settle it and the handoff verdict reads
   * it (#2681). Lives only on the session so it dies with invalidation and restart.
   */
  commandCharges: RunnerCommandAccounting;
  // Records the last allowlisted mutating interaction that the runner confirmed
  // healthy (parsed ok, non-runnerFatal) for a given app bundle. Lives only on
  // the session object so it dies with every invalidation/restart (#702).
  lastHealthyMutation?: { atMs: number; appBundleId?: string };
  /**
   * Whether the runner reported main-thread XCTest work past its execution watchdog still
   * draining, as of the most recent runner response. The runner stamps its live main-thread
   * occupancy onto every successful response and answers new commands with `RUNNER_BUSY` while
   * that work is outstanding, so this mirrors the runner's own state at the last exchange rather
   * than reconstructing it. A stuck runner refuses every command until it drains or escalates to
   * `RUNNER_WEDGED`, so retaining one after `close` hands the same stalled runner back to the next
   * `open` and `close` recovers nothing (#2552). Lives only on the session so it dies with
   * invalidation/restart.
   */
  runnerMainThreadBusy?: boolean;
  /**
   * Started by a prewarm and not yet used by any command. A proven observation-only plan may
   * release it; the first real command clears the mark and the session stays under idle-stop.
   */
  speculative?: boolean;
  startupTimings?: Record<string, number>;
  startupTimingsReported?: boolean;
  /**
   * Device-readiness facts the pre-build probe read for this startup. An adopted session has none:
   * it skipped the probe. Carried so a failure raised after the build still reports the disk image
   * state the device was in, which is the only way a locked phone's early exit says why (#2683).
   */
  startupDeviceStates?: IosRunnerDeviceStates;
  logicalLeaseContext?: RunnerLogicalLeaseContext;
  lease?: RunnerLease;
};

// A session goes forward through the lifecycle once: a state already reached is never re-entered,
// so a runner cannot be revived by a late answer and a finished teardown never runs again. Both
// live states reach `stopped` without a `draining` step on the graceful-shutdown handoff, where
// the runner keeps serving the next daemon and this session's ownership simply ends. That handoff
// covers only a `ready` session (#2681): a daemon shutting down during a startup has a runner that
// never proved it serves requests, so it is torn down by the shutdown's own stop path instead.
const RUNNER_SESSION_STATE_SUCCESSORS: Record<RunnerSessionState, readonly RunnerSessionState[]> = {
  starting: ['ready', 'draining', 'stopped'],
  ready: ['draining', 'stopped'],
  draining: ['stopped'],
  stopped: [],
};

/**
 * The one place a runner session's state changes: publishing a first answer, disposal starting,
 * and disposal or handoff finishing. A state the session already passed is never written again, so
 * an answer arriving after disposal began cannot make the session usable.
 */
export function advanceRunnerSessionState(
  session: RunnerSessionStateHolder,
  next: RunnerSessionState,
): void {
  if (!RUNNER_SESSION_STATE_SUCCESSORS[session.state].includes(next)) return;
  session.state = next;
}

/**
 * Whether this session still owns a runner worth waiting on: no teardown has begun for it, so a
 * stop or invalidate asked of it is real work and not a repeat of one already finished.
 */
export function canWorkWithRunnerSession(session: RunnerSessionStateHolder): boolean {
  return session.state === 'starting' || session.state === 'ready';
}

/**
 * Whether the runner reported main-thread XCTest work still draining as of its last exchange
 * (#2552). Retention and handoff both refuse a runner that is still draining, and both must read
 * the runner's report — the lifecycle state says nothing about what the main thread is doing.
 */
export function isRunnerMainThreadOccupied(
  session: Pick<RunnerSession, 'runnerMainThreadBusy'> | undefined,
): boolean {
  return session?.runnerMainThreadBusy === true;
}

/** Why a graceful shutdown must stop this session's runner instead of handing it over. */
export type RunnerDetachRefusal =
  /** The runner never answered a command, so nothing proves it serves requests (#2681). */
  | 'runner_never_served_a_command'
  /** A command is still owed a response, so the runner is busy whatever its last report says (#2681). */
  | 'command_in_flight'
  /** The runner reported main-thread work still draining as of its last exchange. */
  | 'main_thread_occupied';

export type RunnerDetachDecision =
  | { detach: true }
  | { detach: false; reason: RunnerDetachRefusal };

/** One exchange the runner took and this process has not seen answered. */
type RunnerCommandCharge = {
  /** The id this exchange put on the wire, and the only key its evidence arrives under. */
  readonly commandId: string;
  /** Whether this process gave up on the exchange while the runner may still be executing it. */
  abandoned: boolean;
};

/** Whether terminal journal evidence found the abandoned charge it belongs to. */
export type RunnerChargeSettlement = Readonly<{
  settled: boolean;
  /** Why nothing settled: that command holds no abandoned charge here. */
  refused: 'no_abandoned_charge' | undefined;
}>;

/**
 * What a session owes its runner: one charge per queued command sent and not yet answered.
 *
 * Invariants:
 * - A charge is taken when a request goes out and released only by that command's own answer or its
 *   own terminal journal evidence. An exchange abandoned to a cancellation or a dropped transport
 *   keeps its charge, because the runner is still executing it and nothing here learns when that ends.
 * - Only queued exchanges are charged. The runner answers a readiness probe inline, off its journal and
 *   its serial command queue, so a probe says nothing about what the queue still holds and a probe
 *   reply must be able to settle nothing. (The readiness preflight's own probe has always worked this
 *   way.) A probe that needs an answer gets one by being answered, not by discharging someone else.
 * - Charges are ordered by send. A queued answer forgives at most one abandoned charge that predates
 *   it, since the serial queue only proves the work ahead of the answer finished; an abandoned charge
 *   sent later stays. An answer that lands on a charge already marked abandoned is that exchange's own
 *   late reply, so it forgives nothing further.
 * - Terminal evidence names one `commandId` and discharges only abandoned charges carrying it: the
 *   runner runs one execution per id, so every send waiting on that execution landed. A charge still
 *   awaited belongs to a live exchange and stays for its own answer.
 *
 * {@link resolveRunnerDetachDecision} is the only reader, so a handoff never reconstructs occupancy
 * from elsewhere. The owning session holds the one instance; it dies with invalidation and restart.
 */
export class RunnerCommandAccounting {
  private readonly charges: RunnerCommandCharge[] = [];

  /** Whether anything is owed: an exchange still awaited, or one abandoned and not yet proven landed. */
  get hasOutstandingCharges(): boolean {
    return this.charges.length > 0;
  }

  /** How many exchanges are charged. Diagnostic detail only; the handoff verdict reads the flags. */
  get outstandingChargeCount(): number {
    return this.charges.length;
  }

  /** Whether any outstanding charge was abandoned rather than still awaited. */
  get hasAbandonedCharges(): boolean {
    return this.charges.some((charge) => charge.abandoned);
  }

  /** Charge one queued send. From here a shutdown that hands the runner off orphans real work. */
  charge(commandId: string | undefined): void {
    this.charges.push({ commandId: normalizeRunnerChargeId(commandId), abandoned: false });
  }

  /**
   * This process stopped waiting on an exchange without an answer, so the charge stays and is marked
   * abandoned. A failure naming a command with no charge belongs to an exchange that already settled;
   * marking some other command's debt could hand off a runner that still holds the command whose send
   * actually failed, so it marks nothing.
   */
  markAbandoned(commandId: string | undefined): void {
    const charge = this.findCharge(commandId);
    if (charge) charge.abandoned = true;
  }

  /**
   * Discharge an answered exchange, then forgive one abandoned charge sent before it — the serial
   * queue makes this answer evidence that the queued handling ahead of it finished, and any work still
   * draining is stamped on the reply itself. A run of dropped exchanges therefore keeps one residue
   * per extra exchange rather than being guessed drained.
   */
  settleAnswered(commandId: string | undefined): void {
    const answeredIndex = this.findChargeIndex(commandId);
    if (answeredIndex === -1) return;
    const answered = this.charges[answeredIndex]!;
    this.charges.splice(answeredIndex, 1);
    if (answered.abandoned) return;
    // After the splice, the charges that were sent before the answered one occupy the indices below
    // it, which is exactly the prefix this answer is proof about.
    const residueIndex = this.charges.findIndex(
      (charge, index) => index < answeredIndex && charge.abandoned,
    );
    if (residueIndex !== -1) this.charges.splice(residueIndex, 1);
  }

  /**
   * Terminal journal evidence — a state proving execution ended — for one command. The runner runs one
   * execution per `commandId`, so that command landed and every abandoned charge waiting on that
   * execution is discharged. A repeat observation, an unknown command, a still-awaited exchange, and a
   * blank id all settle nothing. Returns the verdict so the caller can report whether this evidence
   * paid a debt.
   */
  settleTerminalEvidence(commandId: string | undefined): RunnerChargeSettlement {
    const wanted = normalizeRunnerChargeId(commandId);
    // A blank id is evidence about nothing: the runner journals only commands that carried one.
    if (wanted === '') return { settled: false, refused: 'no_abandoned_charge' };
    let settled = false;
    for (let index = this.charges.length - 1; index >= 0; index -= 1) {
      const charge = this.charges[index]!;
      if (!charge.abandoned || charge.commandId !== wanted) continue;
      this.charges.splice(index, 1);
      settled = true;
    }
    return settled
      ? { settled: true, refused: undefined }
      : { settled: false, refused: 'no_abandoned_charge' };
  }

  private findCharge(commandId: string | undefined): RunnerCommandCharge | undefined {
    const index = this.findChargeIndex(commandId);
    return index === -1 ? undefined : this.charges[index];
  }

  /**
   * The newest charge under this id. The runner coalesces a repeated `commandId` onto one execution,
   * so a live and an abandoned charge sharing an id are the same logical command, and the newest
   * exchange settles first. An id the runner never received — a `status` probe carries none — matches
   * no queued charge, since a probe is not charged in the first place.
   */
  private findChargeIndex(commandId: string | undefined): number {
    const wanted = normalizeRunnerChargeId(commandId);
    if (wanted === '') return -1;
    for (let index = this.charges.length - 1; index >= 0; index -= 1) {
      if (this.charges[index]!.commandId === wanted) return index;
    }
    return -1;
  }
}

/** Ids match exactly as sent. */
function normalizeRunnerChargeId(commandId: string | undefined): string {
  return commandId?.trim() ?? '';
}

/**
 * Whether this session's runner may be handed to the next daemon by a graceful shutdown (#2681).
 * `ready` is the only state that proves the runner serves requests: physical startup runs tens of
 * seconds, so a shutdown mid-boot would otherwise hand off a runner that never reached its listener
 * and make the next daemon pay a rebuild it cannot detect. A command the runner accepted without
 * this process seeing an answer is refused outright — including one this process abandoned to a
 * cancellation or a dropped transport, which outlives every wait this side holds. Occupancy is
 * decided by the runner's own report, because a runner still draining abandoned work refuses every
 * command the next daemon sends it.
 */
export function resolveRunnerDetachDecision(
  session: Pick<RunnerSession, 'state' | 'runnerMainThreadBusy' | 'commandCharges'>,
): RunnerDetachDecision {
  if (session.state !== 'ready') {
    return { detach: false, reason: 'runner_never_served_a_command' };
  }
  if (session.commandCharges.hasOutstandingCharges) {
    return { detach: false, reason: 'command_in_flight' };
  }
  if (isRunnerMainThreadOccupied(session)) {
    return { detach: false, reason: 'main_thread_occupied' };
  }
  return { detach: true };
}

/** The liveness of a registered session, read against the process probe held beside its state. */
export function resolveRunnerSessionLiveness(
  session: Readonly<{ state: RunnerSessionState; processRunning: boolean }>,
): RunnerSessionLiveness {
  // A session that died before its runner answered, or whose runner died while it stayed
  // registered, is over either way: the next command finds that by liveness and starts a runner.
  if (!session.processRunning) return 'gone';
  return session.state;
}

export function buildRunnerSessionId(deviceId: string, port: number): string {
  return `${deviceId}:${port}:${Date.now()}`;
}

export function normalizeRunnerStartupTimeoutMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
