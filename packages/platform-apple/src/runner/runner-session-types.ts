import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import type { ExecResult } from './host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerXctestrunArtifact } from './runner-xctestrun.ts';
import type { RunnerLease } from './runner-lease.ts';
import type { XcodebuildSimulatorSetRedirectHandle } from './runner-device-set.ts';

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
  testPromise: Promise<ExecResult>;
  child: RunnerProcessHandle;
  /**
   * Releases this daemon's read side of the runner's stdout/stderr. Only a session launched by this
   * process has one: a runner spawned detached keeps running with no reader, so a handoff releases
   * the pipes at the handoff instead of at process exit, which is what makes a runner that cannot
   * survive a write die where the shutdown can still see it and refuse the handoff (#2681).
   */
  endOutputObservation?: () => void;
  /** Moves only through {@link advanceRunnerSessionState}. */
  state: RunnerSessionState;
  /** Wakes one startup retry when the listener becomes ready or its process exits. */
  startupRetryWake?: AbortSignal;
  startupTimeoutMs?: number;
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
  logicalLeaseContext?: RunnerLogicalLeaseContext;
  simulatorSetRedirect?: XcodebuildSimulatorSetRedirectHandle;
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

/** What the runner reported about its own XCTest main thread at the last exchange (#2552). */
type RunnerOccupancyVerdict = 'drained' | 'occupied' | 'unreported';

/**
 * The one reader of {@link RunnerSession.runnerMainThreadBusy}: the runner's occupancy report, or
 * `unreported` when nothing has stamped it yet. Retention and handoff both refuse a runner that is
 * still draining, and both must read the report — not the lifecycle state, which says nothing about
 * what the main thread is doing.
 */
function readRunnerOccupancyVerdict(
  session: Pick<RunnerSession, 'runnerMainThreadBusy'>,
): RunnerOccupancyVerdict {
  if (session.runnerMainThreadBusy === true) return 'occupied';
  if (session.runnerMainThreadBusy === false) return 'drained';
  return 'unreported';
}

export function isRunnerMainThreadOccupied(
  session: Pick<RunnerSession, 'runnerMainThreadBusy'>,
): boolean {
  return readRunnerOccupancyVerdict(session) === 'occupied';
}

/** Why a graceful shutdown must stop this session's runner instead of handing it over. */
export type RunnerDetachRefusal =
  /** The runner never answered a command, so nothing proves it serves requests (#2681). */
  | 'runner_never_served_a_command'
  /** The runner reported main-thread work still draining as of its last exchange. */
  | 'main_thread_occupied';

export type RunnerDetachDecision =
  | { detach: true }
  | { detach: false; reason: RunnerDetachRefusal };

/**
 * Whether this session's runner may be handed to the next daemon by a graceful shutdown (#2681).
 * `ready` is the only state that proves the runner serves requests: physical startup runs tens of
 * seconds, so a shutdown mid-boot would otherwise hand off a runner that never reached its listener
 * and make the next daemon pay a rebuild it cannot detect. Occupancy is decided by the runner's own
 * report, because a runner still draining abandoned work refuses every command the next daemon
 * sends it.
 */
export function resolveRunnerDetachDecision(
  session: Pick<RunnerSession, 'state' | 'runnerMainThreadBusy'>,
): RunnerDetachDecision {
  if (session.state !== 'ready') {
    return { detach: false, reason: 'runner_never_served_a_command' };
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
