import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import type { ExecResult } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Deadline } from './host.ts';
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
  /**
   * The budget the runner has to answer its first command, opened the moment its process was
   * launched. Every request that joins the `starting` session measures readiness from this one
   * clock, so a runner that never answers is given up once, not once per joiner (#2894).
   */
  launchDeadline?: Deadline;
  /**
   * Commands the runner accepted that this process has not seen answered. It comes down only when a
   * response is decoded: an aborted or dropped exchange leaves the command running on the runner,
   * and nothing in this process learns when that ends, so the count is what keeps such a runner off
   * the handoff path (#2681).
   */
  inFlightCommands: number;
  /**
   * Whether an exchange this process gave up on is among {@link inFlightCommands} — the sticky half
   * of the occupancy report, since a cancellation or transport drop resets every live wait while the
   * runner keeps working. An answered exchange forgives them (the runner is demonstrably serving
   * again, and stamps any work still draining onto its reply) and clears this.
   */
  hasAbandonedCommands: boolean;
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
  session: Pick<
    RunnerSession,
    'state' | 'runnerMainThreadBusy' | 'inFlightCommands' | 'hasAbandonedCommands'
  >,
): RunnerDetachDecision {
  if (session.state !== 'ready') {
    return { detach: false, reason: 'runner_never_served_a_command' };
  }
  if (session.inFlightCommands > 0 || session.hasAbandonedCommands) {
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
