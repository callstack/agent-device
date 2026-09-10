import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createSnapshotSourceHost } from './host.ts';
import { readSnapshotSourceToolchain } from './cache-identity.ts';
import { createSnapshotSourceDeadline, type SnapshotSourceDeadline } from './deadline.ts';
import { SnapshotSourceError } from './errors.ts';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import type { SnapshotSourceHost } from './types.ts';

// Apple's syspolicyd signature scan blocks the first xcodebuild/xcrun exec
// after a fresh macOS host boots for roughly 18 to 19 seconds; the immediate
// next exec of the same tool is instant (#2422). These cases exercise the
// resulting one-retry policy, and the deadline that bounds it, without waiting
// on a real cold-start stall: the fake clock only moves when a probe actually
// blocks for the timeout it was handed, so a case that claims the budget was
// spent had to spend it.

test('a cold-start toolchain probe recovers on retry, and the retry gets only what the stall left', async () => {
  const clock = { nowMs: 0 };
  const timeouts: number[] = [];
  let calls = 0;
  const host = fakeToolchainHost((command, args, options) => {
    calls += 1;
    timeouts.push(options.timeoutMs ?? 0);
    if (calls === 1) throw blockForWholeTimeout(clock, command, options);
    return toolchainAnswer(command, args);
  });

  const identity = await readSnapshotSourceToolchain(
    host,
    'iOS 26.2',
    fakeClockDeadline(40_000, clock),
  );

  assert.equal(identity.xcode, 'Xcode 26.2\nBuild version 17C52');
  assert.equal(identity.macosBuild, '24G90');
  assert.equal(identity.architecture, 'arm64');
  assert.equal(identity.simulatorSdk, '26.2');
  // The stalled first attempt is capped at the 30 s per-probe ceiling; the
  // retry runs on the 10 s the shared deadline has left, not a second 30 s.
  assert.deepEqual(timeouts.slice(0, 2), [30_000, 10_000]);
  assert.equal(clock.nowMs, 30_000);
  // 5 baseline probes (xcodebuild, sw_vers x2, uname, xcrun) plus the one
  // retry that recovered the first, timed-out call.
  assert.equal(calls, 6);
});

test('a toolchain host that never returns still fails at the deadline with the same timeout error', async () => {
  const clock = { nowMs: 0 };
  const timeouts: number[] = [];
  const host = fakeToolchainHost((command, _args, options) => {
    timeouts.push(options.timeoutMs ?? 0);
    throw blockForWholeTimeout(clock, command, options);
  });

  await assert.rejects(
    readSnapshotSourceToolchain(host, 'iOS 26.2', fakeClockDeadline(120_000, clock)),
    (error: unknown) =>
      error instanceof AppError && error.message === 'xcodebuild timed out after 30000ms',
  );
  // Exactly one retry, not an unbounded loop, and the retry is charged the
  // remainder rather than a fresh ceiling.
  assert.deepEqual(timeouts, [30_000, 30_000]);
  assert.equal(clock.nowMs, 60_000);
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
    readSnapshotSourceToolchain(host, 'iOS 26.2', fakeClockDeadline(120_000, clock)),
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
  expected: 'cancelled' | 'exec-timeout' | 'command-failure';
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
    // Nothing left to retry on, so the original timeout propagates unchanged.
    label: 'never aborted, the first probe spends the whole deadline',
    firstProbe: 'exec-timeout',
    aborts: 'never',
    deadlineMs: 30_000,
    expected: 'exec-timeout',
    execs: 1,
    clockMs: 30_000,
  },
];

test.each(CANCELLATION_CASES)('cancellation matrix: $label', async (testCase) => {
  const clock = { nowMs: 0 };
  const request = new AbortController();
  if (testCase.aborts === 'before-the-deadline') request.abort();
  let execs = 0;
  const host = fakeToolchainHost((command, args, options) => {
    execs += 1;
    if (execs > 1 || !testCase.firstProbe) return toolchainAnswer(command, args);
    if (testCase.aborts === 'while-it-blocks') request.abort();
    const failure =
      testCase.firstProbe === 'exec-timeout'
        ? blockForWholeTimeout(clock, command, options)
        : // No `timeoutMs` detail: the tool failed on its own, so nothing retries it.
          new AppError('COMMAND_FAILED', `${command}: unexpected error`, { cmd: command });
    if (testCase.aborts === 'as-it-unwinds') request.abort();
    throw failure;
  });

  await assert.rejects(
    // The deadline is opened inside the rejected call: an already-aborted request must
    // fail as it is opened, before any probe runs.
    async () =>
      await readSnapshotSourceToolchain(
        host,
        'iOS 26.2',
        createSnapshotSourceDeadline(testCase.deadlineMs, request.signal, () => clock.nowMs),
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
    assert.ok(error instanceof SnapshotSourceError, `${testCase.label}: expected a cancellation`);
    assert.equal(error.failureKind, 'cancelled', testCase.label);
    assert.equal(error.failureCode, 'abort-signal', testCase.label);
    assert.equal(error.details?.reason, 'request_canceled', testCase.label);
    return;
  }
  assert.ok(error instanceof AppError, `${testCase.label}: expected the probe's own failure`);
  assert.equal(
    error.message,
    testCase.expected === 'exec-timeout'
      ? 'xcodebuild timed out after 30000ms'
      : 'xcodebuild: unexpected error',
    testCase.label,
  );
}

/** A deadline read against a clock only {@link blockForWholeTimeout} advances. */
function fakeClockDeadline(timeoutMs: number, clock: { nowMs: number }): SnapshotSourceDeadline {
  return createSnapshotSourceDeadline(timeoutMs, undefined, () => clock.nowMs);
}

/** A probe that blocked for its whole timeout and was then killed, as the exec layer reports it. */
function blockForWholeTimeout(
  clock: { nowMs: number },
  command: string,
  options: ExecOptions,
): AppError {
  const timeoutMs = options.timeoutMs ?? 0;
  clock.nowMs += timeoutMs;
  return new AppError('COMMAND_FAILED', `${command} timed out after ${timeoutMs}ms`, { timeoutMs });
}

function toolchainAnswer(command: string, args: string[]): ExecResult {
  const stdout =
    command === 'xcodebuild'
      ? 'Xcode 26.2\nBuild version 17C52'
      : command === 'sw_vers'
        ? args.includes('-buildVersion')
          ? '24G90'
          : '15.6'
        : command === 'uname'
          ? 'arm64'
          : '26.2';
  return { stdout, stderr: '', exitCode: 0 };
}

function fakeToolchainHost(
  run: (command: string, args: string[], options: ExecOptions) => ExecResult,
): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    run: async (command, args, options) => run(command, args, options ?? {}),
  };
}
