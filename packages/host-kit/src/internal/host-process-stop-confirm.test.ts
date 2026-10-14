import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

// Every claim the stopper makes is about what the host answers, so one double answers both syscalls it
// reads: `kill(pid, signal)` for the signals and liveness probes, and `ps` for the identity fields.
// One host state drives both, so no case can be live while its identity says otherwise.
const { mockRunCmd } = vi.hoisted(() => ({ mockRunCmd: vi.fn() }));
vi.mock('./exec.ts', async () => ({
  ...(await vi.importActual<typeof import('./exec.ts')>('./exec.ts')),
  runCmd: mockRunCmd,
}));

import {
  stopProcessAndConfirmExit,
  type ConfirmedProcessStop,
  type ProcessStopTarget,
} from './host-process.ts';

const PID = 4242;
const BUDGET = { termTimeoutMs: 1_000, killTimeoutMs: 500 };
type Signal = 'SIGTERM' | 'SIGKILL';

const START = 'Mon Oct 12 00:00:00 2026';
const OTHER_START = 'Tue Oct 13 09:00:00 2026';
const COMMAND = '/usr/bin/node /app/dist/src/client/companion-tunnel.js --run-metro-companion';

const STOPPED: ConfirmedProcessStop = { status: 'stopped' };
/** `ps` found the row and told nothing for that column, which is unknown rather than absent. */
const EMPTY = { stdout: '', stderr: '', exitCode: 0 };
const PS_REFUSED = { stdout: '', stderr: 'ps: not permitted', exitCode: 1 };
const psAnswer = (value: string) => ({ stdout: `${value}\n`, stderr: '', exitCode: 0 });
const refused = (signal: Signal): ConfirmedProcessStop => ({
  status: 'retained',
  reason: 'signal-failed',
  signal,
  errno: 'EPERM',
});

/** What the host will say about the pid, overriding what the recorded process would show. */
type HostIdentity = Readonly<{ startTime?: string | null; command?: string | null }>;

type HostCase = Readonly<{
  name: string;
  /**
   * Which claims the caller recorded about the pid. Defaults to having recorded both; `'none'` is a
   * caller that stored only the pid.
   */
  claims?: 'startTime' | 'matches' | 'both' | 'none';
  /** What the host answers each signal with: a string is the refusing errno, absent accepts. */
  answers?: Partial<Record<Signal, string>>;
  /** The signal after which the process has run its course, when it ends because it was asked. */
  exitsOnSignal?: Signal;
  /** How many liveness probes it survives before somebody else ends it. */
  exitsAfterProbes?: number;
  /**
   * How a process that has run its course keeps answering to its pid, which is where liveness and
   * identity disagree: a POSIX zombie answers `EPERM` beside a `Z` row. `'held'` never lets go.
   */
  afterExit?: 'zombie' | 'held';
  identity?: HostIdentity;
  /** A `ps` the host refuses outright, so identity cannot be read at all. */
  psFails?: boolean;
  /** The signals the stop must spend, in order, and the verdict each host answer earns. */
  expect: { outcome: ConfirmedProcessStop; signals: Signal[] };
}>;

type HostModel = Omit<HostCase, 'name' | 'expect'>;
type Expect = HostCase['expect'];
const HELD = { afterExit: 'held' } satisfies HostModel;
const DENIED_ON_TERM = { answers: { SIGTERM: 'EPERM' } } satisfies HostModel;
const UNREADABLE = { identity: { startTime: null, command: null } } satisfies HostModel;
/** The process has run its course: liveness stops answering for it before anything is signaled. */
const GONE = { exitsAfterProbes: 0 } satisfies HostModel;
const ZOMBIE = { ...GONE, afterExit: 'zombie' } satisfies HostModel;
const STOPPED_BY_TERM: Expect = { outcome: STOPPED, signals: ['SIGTERM'] };
const STOPPED_BY_KILL: Expect = { outcome: STOPPED, signals: ['SIGTERM', 'SIGKILL'] };
const NEVER_SIGNALED: Expect = { outcome: STOPPED, signals: [] };
const REFUSED_ON_TERM: Expect = { outcome: refused('SIGTERM'), signals: ['SIGTERM'] };
const REFUSED_ON_KILL: Expect = { outcome: refused('SIGKILL'), signals: STOPPED_BY_KILL.signals };
const EXIT_TIMED_OUT: Expect = {
  outcome: { status: 'retained', reason: 'exit-timeout', signal: 'SIGKILL' },
  signals: STOPPED_BY_KILL.signals,
};
const UNVERIFIED: Expect = {
  outcome: { status: 'retained', reason: 'identity-unverified' },
  signals: [],
};

const STOP_CASES: HostCase[] = [
  // A caller that recorded nothing about the pid cannot name the process at all, so no signal is
  // spent on it: the pid is retained rather than handed to whatever holds it now.
  { name: 'is a pid nobody recorded anything about', claims: 'none', ...HELD, expect: UNVERIFIED },
  // Confirming one claim is not enough when the other is the one the host will not answer: the
  // readable fact has to be the recorded one, or a silent column authorises a blind signal.
  {
    name: 'has only a command matcher and the host withholds the command line',
    claims: 'matches',
    identity: { command: null },
    ...HELD,
    expect: UNVERIFIED,
  },
  {
    name: 'has only a recorded start time and the host withholds the start time',
    claims: 'startTime',
    identity: { startTime: null },
    ...HELD,
    expect: UNVERIFIED,
  },

  // Escalation, refusal and the two ways a signal stage proves the exit.
  { name: 'leaves on SIGTERM', exitsOnSignal: 'SIGTERM', expect: STOPPED_BY_TERM },
  {
    name: 'ignores SIGTERM and takes SIGKILL',
    exitsOnSignal: 'SIGKILL',
    expect: STOPPED_BY_KILL,
  },
  { name: 'was gone before anything was signaled', ...GONE, expect: NEVER_SIGNALED },
  {
    name: 'is held by another owner',
    ...DENIED_ON_TERM,
    ...HELD,
    expect: REFUSED_ON_TERM,
  },
  {
    name: 'refuses SIGKILL',
    answers: { SIGKILL: 'EPERM' },
    ...HELD,
    expect: REFUSED_ON_KILL,
  },
  {
    name: 'is released inside the budget',
    ...DENIED_ON_TERM,
    exitsAfterProbes: 3,
    expect: STOPPED_BY_TERM,
  },
  {
    // Liveness keeps answering for a zombie that outlives its budget, so only the `Z` row proves
    // the recorded process is gone, and it does that after the wait rather than before the signal.
    name: 'leaves a zombie the budget cannot wait out',
    exitsOnSignal: 'SIGTERM',
    afterExit: 'zombie',
    expect: STOPPED_BY_TERM,
  },
  { name: 'outlives both budgets', ...HELD, expect: EXIT_TIMED_OUT },

  // What the recorded identity buys: a stale pid is proven without signaling it, and a host that
  // will not describe the pid stops the stopper instead of authorizing a blind signal.
  {
    name: 'left a zombie before anything was signaled',
    ...ZOMBIE,
    expect: NEVER_SIGNALED,
  },
  {
    // Windows hides only the command line of an elevated or other-user process, and that is the #3540
    // companion: it must be signaled and retained, never reported stopped.
    name: 'recorded process hides its command line, as an elevated one does',
    identity: { command: null },
    ...DENIED_ON_TERM,
    ...HELD,
    expect: REFUSED_ON_TERM,
  },
  {
    name: 'recorded process hides its start time',
    identity: { startTime: null },
    ...DENIED_ON_TERM,
    ...HELD,
    expect: REFUSED_ON_TERM,
  },
  {
    // POSIX `hidepid`, a `ps` that times out, or a Windows process that exited while its object still
    // had handles: the pid answers `kill(pid, 0)` and nothing else, which is unknown, not absent.
    name: 'live recorded pid the host will not describe',
    ...UNREADABLE,
    ...HELD,
    expect: UNVERIFIED,
  },
  {
    name: 'live recorded pid whose process tool the host refuses',
    psFails: true,
    ...HELD,
    expect: UNVERIFIED,
  },
  {
    name: 'pid the host has handed to another lifetime',
    identity: { startTime: OTHER_START },
    expect: NEVER_SIGNALED,
  },
  {
    name: 'pid whose command line names a different program',
    identity: { command: '/usr/bin/other --serve' },
    expect: NEVER_SIGNALED,
  },
];

function driveHost(model: HostCase): { signals: Signal[] } {
  const signals: Signal[] = [];
  let ended = false;
  let probes = 0;
  const hasEnded = () =>
    ended ||
    (model.afterExit !== 'held' && probes >= (model.exitsAfterProbes ?? Number.POSITIVE_INFINITY));
  vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal: string | number) => {
    if (signal === 0) {
      probes += 1;
      // A released pid answers `ESRCH`. A zombie, and on Windows a process whose object still has
      // handles, both keep answering `EPERM`, and only the process table tells those apart.
      if (hasEnded() && model.afterExit === undefined)
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (hasEnded()) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return true;
    }
    const name = signal as Signal;
    signals.push(name);
    const errno = model.answers?.[name];
    if (errno) throw Object.assign(new Error(`kill refused: ${errno}`), { code: errno });
    if (model.exitsOnSignal === name) ended = true;
    return true;
  }) as typeof process.kill);

  // Absent means the recorded process, `null` means the host withholds the column, and a string is
  // what it says instead.
  const identity = {
    startTime: model.identity?.startTime === undefined ? START : model.identity.startTime,
    command: model.identity?.command === undefined ? COMMAND : model.identity.command,
  };
  mockRunCmd.mockImplementation(async (_command: string, args: readonly string[]) => {
    if (model.psFails) return PS_REFUSED;
    // A process the host has fully released, and one that left no row, both answer no fields.
    if (hasEnded() && model.afterExit !== 'zombie') return EMPTY;
    const field = String(args[3]);
    if (field === 'state=') return psAnswer(hasEnded() && model.afterExit === 'zombie' ? 'Z' : 'S');
    // Withheld is its own answer: `ps` finds the row and reports nothing for that column, which is
    // how Windows answers `CommandLine` for another user's process.
    const column = field === 'lstart=' ? identity.startTime : identity.command;
    return column === null ? EMPTY : psAnswer(column);
  });
  return { signals };
}

function targetOf(model: HostCase): ProcessStopTarget {
  const claims = model.claims ?? 'both';
  return {
    pid: PID,
    identity: {
      startTime: claims === 'startTime' || claims === 'both' ? START : undefined,
      matches: claims === 'matches' || claims === 'both' ? (c) => c === COMMAND : undefined,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockRunCmd.mockReset();
});

// The host model above answers with POSIX `ps` fields; a Windows host answers the same questions from
// CIM, which never reports a zombie state. win32 branches live in host-process-windows.test.ts.
test.skipIf(process.platform === 'win32').each(STOP_CASES)(
  'stopProcessAndConfirmExit $name',
  async (testCase) => {
    const host = driveHost(testCase);
    // Both stage budgets, advanced on a fake clock: a retained outcome must not cost real time.
    vi.useFakeTimers();
    const stop = stopProcessAndConfirmExit(targetOf(testCase), BUDGET);
    await vi.advanceTimersByTimeAsync(BUDGET.termTimeoutMs + BUDGET.killTimeoutMs);

    assert.deepEqual(await stop, testCase.expect.outcome);
    assert.deepEqual(host.signals, testCase.expect.signals);
  },
);

// `kill(0, SIGTERM)` addresses this very process group, so an unvalidated pid must not reach it.
test.each([0, -1, 1.5, Number.NaN])(
  'never signals a pid that is not a process: %s',
  async (pid) => {
    const signals: string[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal: string) => {
      signals.push(signal);
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }) as typeof process.kill);
    assert.deepEqual(await stopProcessAndConfirmExit({ pid, identity: {} }, BUDGET), STOPPED);
    assert.deepEqual(signals, []);
  },
);

// Stale or malformed process state can name the caller's own pid, and SIGTERM would end the very
// process trying to stop it.
test('refuses to stop the current process', async () => {
  const signals: string[] = [];
  vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal: string) => {
    signals.push(signal);
    return true;
  }) as typeof process.kill);
  await assert.rejects(
    () => stopProcessAndConfirmExit({ pid: process.pid, identity: {} }, BUDGET),
    RangeError,
  );
  assert.deepEqual(signals, []);
});

// Node's own argument faults carry a `code` that is not an errno, and reading one as a refusal would
// send the caller off to stop a process that never existed. The fault itself has to reach it.
test('propagates an argument fault instead of reporting it as a host refusal', async () => {
  const failure = Object.assign(new TypeError('bad signal'), { code: 'ERR_INVALID_ARG_TYPE' });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw failure;
  });
  const settled = await stopProcessAndConfirmExit({ pid: PID, identity: {} }, BUDGET).catch(
    (error: unknown) => error,
  );
  assert.equal(settled, failure);
});
