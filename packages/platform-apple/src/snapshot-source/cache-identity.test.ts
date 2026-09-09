import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createSnapshotSourceHost } from './host.ts';
import { readSnapshotSourceToolchain } from './cache-identity.ts';
import { createSnapshotSourceDeadline, type SnapshotSourceDeadline } from './deadline.ts';
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

test('a probe that spends the whole deadline is not retried', async () => {
  const clock = { nowMs: 0 };
  const timeouts: number[] = [];
  const host = fakeToolchainHost((command, _args, options) => {
    timeouts.push(options.timeoutMs ?? 0);
    throw blockForWholeTimeout(clock, command, options);
  });

  await assert.rejects(
    readSnapshotSourceToolchain(host, 'iOS 26.2', fakeClockDeadline(30_000, clock)),
    (error: unknown) =>
      error instanceof AppError && error.message === 'xcodebuild timed out after 30000ms',
  );
  // Nothing left to retry on, so the original timeout propagates unchanged.
  assert.deepEqual(timeouts, [30_000]);
  assert.equal(clock.nowMs, 30_000);
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
