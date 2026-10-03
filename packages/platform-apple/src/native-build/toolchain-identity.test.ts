import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isCommandTimeoutError,
  withCommandExecutorOverride,
  type ExecOptions,
  type ExecResult,
} from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { createNativeBuildDeadline, type NativeBuildDeadline } from './deadline.ts';
import { NativeBuildError } from './errors.ts';
import { createNativeBuildHost, type NativeBuildHost } from './host.ts';
import { readHostToolchainIdentity } from './toolchain-identity.ts';
import { execKillTimeoutError } from './__tests__/exec-timeout-fixture.ts';

// Apple's syspolicyd signature scan blocks the first exec of an Xcode-owned tool after a fresh
// macOS host boots for roughly 18 to 19 seconds; the immediate next exec of the same tool is
// instant (#2422). These cases exercise the resulting one-retry policy, and the deadline that
// bounds it, without waiting on a real cold-start stall: the fake clock only moves when a probe
// actually blocks for the timeout it was handed, so a case that claims the budget was spent had to
// spend it.

test('a Rosetta-translated process builds for the arm64 simulator the Mac runs', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
  try {
    const host = createNativeBuildHost(async (command, args) => toolchainAnswer(command, args));
    const identity = await withCommandExecutorOverride(
      async (command, args) => {
        assert.deepEqual([command, ...args], ['/usr/sbin/sysctl', '-n', 'hw.optional.arm64']);
        return { stdout: '1\n', stderr: '', exitCode: 0 };
      },
      () => readHostToolchainIdentity(host, fakeClockDeadline(40_000, { nowMs: 0 })),
    );
    assert.equal(identity.architecture, 'arm64');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
  }
});

test('a request cancelled while the host arch is still resolving stops waiting for it', async () => {
  const request = new AbortController();
  const host: NativeBuildHost = {
    ...createNativeBuildHost(async (command, args) => toolchainAnswer(command, args)),
    cpuArch: () => {
      request.abort();
      return new Promise<string>(() => {});
    },
  };

  await assert.rejects(
    readHostToolchainIdentity(host, createNativeBuildDeadline(40_000, request.signal)),
    (error: unknown) =>
      error instanceof NativeBuildError &&
      error.buildFailureKind === 'cancelled' &&
      error.buildFailureCode === 'abort-signal',
  );
});

test('a host arch that outlives the request budget reports the deadline', async () => {
  const clock = { nowMs: 0 };
  const host: NativeBuildHost = {
    ...createNativeBuildHost(async (command, args) => {
      if (command === 'sw_vers' && args.includes('-buildVersion')) clock.nowMs = 39_990;
      return toolchainAnswer(command, args);
    }),
    cpuArch: () => new Promise<string>(() => {}),
  };

  await assert.rejects(
    readHostToolchainIdentity(host, fakeClockDeadline(40_000, clock)),
    (error: unknown) =>
      error instanceof NativeBuildError &&
      error.buildFailureKind === 'timeout' &&
      error.buildFailureCode === 'host-arch-deadline',
  );
});

test('a cold-start toolchain probe recovers on retry, and the retry gets only what the stall left', async () => {
  const clock = { nowMs: 0 };
  const timeouts: number[] = [];
  let calls = 0;
  const host = fakeToolchainHost(async (command, args, options) => {
    calls += 1;
    timeouts.push(options.timeoutMs ?? 0);
    if (calls === 1) throw await blockForWholeTimeout(clock, options);
    return toolchainAnswer(command, args);
  });

  const identity = await readHostToolchainIdentity(host, fakeClockDeadline(40_000, clock));

  assert.equal(identity.xcode, 'Xcode 26.2\nBuild version 17C52');
  assert.equal(identity.macosBuild, '24G90');
  assert.equal(identity.architecture, 'arm64');
  // The stalled first attempt is capped at the 30 s per-probe ceiling; the
  // retry runs on the 10 s the shared deadline has left, not a second 30 s.
  assert.deepEqual(timeouts.slice(0, 2), [30_000, 10_000]);
  assert.equal(clock.nowMs, 30_000);
  // 3 baseline probes (xcodebuild, sw_vers x2) plus the one
  // retry that recovered the first, timed-out call.
  assert.equal(calls, 4);
});

// The identity read is allowed to exec one Xcode-owned binary. The Simulator SDK a second
// `xcrun` probe used to report ships inside the selected `Xcode.app`, so it cannot move under a
// `xcodebuild -version` build that already pins it -- and every extra Xcode-owned exec is another
// toolchain the job can wait on and fail against (#2712).
test('the toolchain identity execs one Xcode-owned binary, and no xcrun', async () => {
  const clock = { nowMs: 0 };
  const probed: string[] = [];
  const host = fakeToolchainHost((command, args) => {
    probed.push(command);
    return toolchainAnswer(command, args);
  });

  await readHostToolchainIdentity(host, fakeClockDeadline(120_000, clock));

  assert.deepEqual(probed, ['xcodebuild', 'sw_vers', 'sw_vers']);
});

test('a toolchain host that never returns reports the stalled probe after one retry', async () => {
  const clock = { nowMs: 0 };
  const timeouts: number[] = [];
  const host = fakeToolchainHost(async (_command, _args, options) => {
    timeouts.push(options.timeoutMs ?? 0);
    throw await blockForWholeTimeout(clock, options);
  });

  await assert.rejects(
    readHostToolchainIdentity(host, fakeClockDeadline(120_000, clock)),
    (error: unknown) => {
      assertToolchainProbeStall(error, 'xcodebuild', [30_000, 30_000]);
      return true;
    },
  );
  // Exactly one retry, not an unbounded loop: with 90 s left after the first 30 s stall, the
  // retry still gets the full per-probe ceiling. The cold-start case above is where the retry is
  // charged the remainder instead ([30_000, 10_000]).
  assert.deepEqual(timeouts, [30_000, 30_000]);
  assert.equal(clock.nowMs, 60_000);
});

// The stall names the probe that hit it, not just the first one in the sequence: a host whose
// `sw_vers` answers late must not read as an Xcode problem.
test('a later probe that stalls out names that probe and its own attempts', async () => {
  const clock = { nowMs: 0 };
  let macosBuildCalls = 0;
  const host = fakeToolchainHost(async (command, args, options) => {
    if (command !== 'sw_vers' || !args.includes('-buildVersion')) {
      return toolchainAnswer(command, args);
    }
    macosBuildCalls += 1;
    throw await blockForWholeTimeout(clock, options);
  });

  await assert.rejects(
    readHostToolchainIdentity(host, fakeClockDeadline(120_000, clock)),
    (error: unknown) => {
      assertToolchainProbeStall(error, 'sw_vers', [30_000, 30_000]);
      return true;
    },
  );
  assert.equal(macosBuildCalls, 2);
});

test('a probe that failed on its own and merely says "timed out" in its message is not retried', async () => {
  const clock = { nowMs: 0 };
  let calls = 0;
  const host = fakeToolchainHost((command) => {
    calls += 1;
    // No `timeoutMs` detail: the tool reported its own failure, the exec layer
    // did not kill it at a timeout we asked for. Retrying that just doubles a
    // failure the retry cannot fix.
    throw new AppError('COMMAND_FAILED', `${command} timed out after 10ms`, { cmd: command });
  });

  await assert.rejects(
    readHostToolchainIdentity(host, fakeClockDeadline(120_000, clock)),
    (error: unknown) =>
      error instanceof AppError && error.message === 'xcodebuild timed out after 10ms',
  );
  assert.equal(calls, 1);
});

/**
 * One row per way a toolchain read can be interrupted: how the probe the row exercises
 * ends, when the owning request aborts relative to it, and what the caller must then see.
 * The retry is the only place a cancellation can be observed -- an exec already running
 * cannot be taken back -- so the exec count is what pins where each row stopped.
 */
type ToolchainProbeCancellationCase = {
  label: string;
  /** How the first probe ends; later probes answer. Absent when no probe runs at all. */
  firstProbe?: 'exec-timeout' | 'command-failure';
  /**
   * When the owning request aborts: never, before the phase even opens its deadline, while
   * the first probe is still blocked, or as that probe's timeout unwinds.
   */
  aborts: 'never' | 'before-the-deadline' | 'while-it-blocks' | 'as-it-unwinds';
  /** The phase deadline. 30 s is spent in full by one stalled probe, leaving no retry. */
  deadlineMs: number;
  expected: 'cancelled' | 'probe-stall' | 'command-failure';
  execs: number;
  clockMs: number;
};

const CANCELLATION_CASES: ToolchainProbeCancellationCase[] = [
  {
    label: 'aborted before the phase opened its deadline',
    aborts: 'before-the-deadline',
    deadlineMs: 120_000,
    expected: 'cancelled',
    execs: 0,
    clockMs: 0,
  },
  {
    // The deadline still had 90 s, so only the cancellation stops the retry.
    label: 'aborted while the first probe blocks, and it then times out',
    firstProbe: 'exec-timeout',
    aborts: 'while-it-blocks',
    deadlineMs: 120_000,
    expected: 'cancelled',
    execs: 1,
    clockMs: 30_000,
  },
  {
    // A probe that failed on its own is never retried, so there is no retry to cancel:
    // the tool's own failure is what the caller sees, and the request fails either way.
    label: 'aborted while the first probe fails with a non-timeout error',
    firstProbe: 'command-failure',
    aborts: 'while-it-blocks',
    deadlineMs: 120_000,
    expected: 'command-failure',
    execs: 1,
    clockMs: 0,
  },
  {
    label: "aborted as the first probe's timeout unwinds, before its retry",
    firstProbe: 'exec-timeout',
    aborts: 'as-it-unwinds',
    deadlineMs: 120_000,
    expected: 'cancelled',
    execs: 1,
    clockMs: 30_000,
  },
  {
    // Nothing left to retry on, so a single stalled attempt already names the probe.
    label: 'never aborted, the first probe spends the whole deadline',
    firstProbe: 'exec-timeout',
    aborts: 'never',
    deadlineMs: 30_000,
    expected: 'probe-stall',
    execs: 1,
    clockMs: 30_000,
  },
];

test.each(CANCELLATION_CASES)('cancellation matrix: $label', async (testCase) => {
  const clock = { nowMs: 0 };
  const request = new AbortController();
  if (testCase.aborts === 'before-the-deadline') request.abort();
  let execs = 0;
  const host = fakeToolchainHost(async (command, args, options) => {
    execs += 1;
    if (execs > 1 || !testCase.firstProbe) return toolchainAnswer(command, args);
    if (testCase.aborts === 'while-it-blocks') request.abort();
    const failure =
      testCase.firstProbe === 'exec-timeout'
        ? await blockForWholeTimeout(clock, options)
        : // No `timeoutMs` detail: the tool failed on its own, so nothing retries it.
          new AppError('COMMAND_FAILED', `${command}: unexpected error`, { cmd: command });
    if (testCase.aborts === 'as-it-unwinds') request.abort();
    throw failure;
  });

  await assert.rejects(
    // The deadline is opened inside the rejected call: an already-aborted request must
    // fail as it is opened, before any probe runs.
    async () =>
      await readHostToolchainIdentity(
        host,
        createNativeBuildDeadline(testCase.deadlineMs, request.signal, () => clock.nowMs),
      ),
    (error: unknown) => {
      assertExpectedToolchainFailure(error, testCase);
      return true;
    },
  );
  assert.equal(execs, testCase.execs, `${testCase.label}: exec count`);
  assert.equal(clock.nowMs, testCase.clockMs, `${testCase.label}: wall clock spent`);
});

function assertExpectedToolchainFailure(
  error: unknown,
  testCase: ToolchainProbeCancellationCase,
): void {
  if (testCase.expected === 'cancelled') {
    assert.ok(error instanceof NativeBuildError, `${testCase.label}: expected a cancellation`);
    assert.equal(error.buildFailureKind, 'cancelled', testCase.label);
    assert.equal(error.buildFailureCode, 'abort-signal', testCase.label);
    return;
  }
  if (testCase.expected === 'probe-stall') {
    assertToolchainProbeStall(error, 'xcodebuild', [30_000]);
    return;
  }
  assert.ok(error instanceof AppError, `${testCase.label}: expected the probe's own failure`);
  assert.equal(error.message, 'xcodebuild: unexpected error', testCase.label);
}

/**
 * A probe that stalled out names itself, says what each attempt was armed with, and keeps the exec
 * layer's own kill as its cause -- so a job can tell "this tool never answered" from a device
 * failure without reading a stack frame (#2712).
 */
function assertToolchainProbeStall(
  error: unknown,
  command: string,
  attemptTimeoutsMs: number[],
): void {
  assert.ok(error instanceof NativeBuildError, `expected a toolchain probe stall, got ${error}`);
  assert.equal(error.buildFailureKind, 'timeout');
  assert.equal(error.buildFailureCode, 'toolchain-probe-stalled');
  assert.equal(error.buildDetails.command, command);
  assert.deepEqual(error.buildDetails.attemptTimeoutsMs, attemptTimeoutsMs);
  assert.match(String(error.buildDetails.hint), new RegExp(`run \`${command}\` by hand`));
  assert.ok(
    isCommandTimeoutError(error.cause),
    'the exec layer kill the probe hit stays the cause',
  );
}

/** A deadline read against a clock only {@link blockForWholeTimeout} advances. */
function fakeClockDeadline(timeoutMs: number, clock: { nowMs: number }): NativeBuildDeadline {
  return createNativeBuildDeadline(timeoutMs, undefined, () => clock.nowMs);
}

/**
 * A probe that blocked for its whole timeout and was then killed. The fake clock advances by the
 * budget the probe was handed, and the failure is the one `exec.ts` really raises for that kill.
 */
async function blockForWholeTimeout(
  clock: { nowMs: number },
  options: ExecOptions,
): Promise<unknown> {
  clock.nowMs += options.timeoutMs ?? 0;
  return await execKillTimeoutError();
}

/**
 * What the host answers each probe the identity read is allowed to run. A command outside this list
 * is a probe the identity read must not open at all (#2712).
 */
function toolchainAnswer(command: string, args: string[]): ExecResult {
  if (command === 'xcodebuild') {
    return { stdout: 'Xcode 26.2\nBuild version 17C52', stderr: '', exitCode: 0 };
  }
  if (command === 'sw_vers') {
    return { stdout: args.includes('-buildVersion') ? '24G90' : '15.6', stderr: '', exitCode: 0 };
  }
  throw new Error(`the identity read execed ${command} ${args.join(' ')}`);
}

function fakeToolchainHost(
  run: (command: string, args: string[], options: ExecOptions) => ExecResult | Promise<ExecResult>,
): NativeBuildHost {
  return {
    ...createNativeBuildHost(async (command, args, options) => run(command, args, options ?? {})),
    cpuArch: async () => 'arm64',
  };
}
