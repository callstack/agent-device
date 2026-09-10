import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecOptions, ExecResult, ExecStreamOptions } from '../host.ts';
import { createRunnerPhaseBudget, ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { MACOS_DEVICE } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

/**
 * The build phase spends one budget, not two (#2422).
 *
 * `ensureXctestrunArtifact` runs the cache decision's blocking toolchain probes
 * before it starts `xcodebuild`. Those probes used to be handed
 * `buildTimeoutMs` and the build was then handed the same number again, so a
 * cold-start probe stall added its 30 to 45 seconds on top of the phase budget
 * instead of coming out of it. These cases pin the shared deadline: the clock
 * moves only when a probe actually blocks for the timeout it was handed, so a
 * case that claims the budget was spent had to spend it.
 */

const clock = { nowMs: 0 };
const runCmdSync = vi.fn();
const runCmdStreaming = vi.fn();
let projectRoot: string;

beforeEach(() => {
  resetAllProcessMemosForTests();
  clock.nowMs = 0;
  projectRoot = mkdtempForTestSync('agent-device-runner-phase-root-');
  // `buildXctestrunArtifact` refuses to start a build without the runner project.
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = mkdtempForTestSync(
    'agent-device-runner-phase-derived-',
  );
  runCmdSync.mockReset().mockImplementation(appleToolchainProbeResult);
  runCmdStreaming
    .mockReset()
    .mockImplementation(async (): Promise<ExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }));
  appleRunnerTestHost.update({
    runCmdSync,
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
    deadlineFromTimeoutMs: (timeoutMs: number) => {
      const startedAtMs = clock.nowMs;
      const expiresAtMs = startedAtMs + Math.max(0, timeoutMs);
      return {
        remainingMs: () => Math.max(0, expiresAtMs - clock.nowMs),
        elapsedMs: () => Math.max(0, clock.nowMs - startedAtMs),
        isExpired: () => expiresAtMs - clock.nowMs <= 0,
      };
    },
  });
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
});

test('a warm toolchain leaves the build the whole phase budget', async () => {
  await assert.rejects(
    ensureXctestrunArtifact(MACOS_DEVICE, { budget: createRunnerPhaseBudget(120_000, undefined) }),
    missingXctestrun,
  );

  assert.equal(clock.nowMs, 0);
  assert.equal(buildTimeoutMsGiven(), 120_000);
});

test('a cold-start probe stall comes out of the build budget instead of being added to it', async () => {
  let xcodebuildProbes = 0;
  runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
    // The syspolicyd stall: the first `xcodebuild` exec blocks for the whole
    // timeout it was handed, the immediate next one answers at once.
    xcodebuildProbes += command === 'xcodebuild' ? 1 : 0;
    if (xcodebuildProbes === 1 && command === 'xcodebuild') {
      throw blockForWholeTimeout(command, options);
    }
    return appleToolchainProbeResult(command, args);
  });

  await assert.rejects(
    ensureXctestrunArtifact(MACOS_DEVICE, { budget: createRunnerPhaseBudget(120_000, undefined) }),
    missingXctestrun,
  );

  // 30 s of stall, absorbed by the retry -- and charged to the phase, so the
  // build is given 90 s rather than a second full 120 s.
  assert.equal(clock.nowMs, 30_000);
  assert.equal(buildTimeoutMsGiven(), 90_000);
});

test('a probe that spends the whole phase fails before xcodebuild is spawned', async () => {
  runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
    // The last of the three probes answers, but only after blocking for
    // everything the phase had left.
    if (args.includes('--show-sdk-build-version')) clock.nowMs += options.timeoutMs ?? 0;
    return appleToolchainProbeResult(command, args);
  });

  await assert.rejects(
    ensureXctestrunArtifact(MACOS_DEVICE, { budget: createRunnerPhaseBudget(30_000, undefined) }),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'runner_phase_budget_exhausted' &&
      error.details?.phase === 'runner_xctestrun_build',
  );

  assert.equal(clock.nowMs, 30_000);
  assert.equal(runCmdStreaming.mock.calls.length, 0);
});

/** The fake build writes no `.xctestrun`; the budget it was handed is what these cases read. */
function missingXctestrun(error: unknown): boolean {
  return error instanceof AppError && error.message === 'Failed to locate .xctestrun after build';
}

function buildTimeoutMsGiven(): number | undefined {
  assert.equal(runCmdStreaming.mock.calls.length, 1);
  const [command, , options] = runCmdStreaming.mock.calls[0] as [
    string,
    string[],
    ExecStreamOptions,
  ];
  assert.equal(command, 'xcodebuild');
  return options.timeoutMs;
}

/** A probe that blocked for its whole timeout and was then killed, as the exec layer reports it. */
function blockForWholeTimeout(command: string, options: ExecOptions): AppError {
  const timeoutMs = options.timeoutMs ?? 0;
  clock.nowMs += timeoutMs;
  return new AppError('COMMAND_FAILED', `${command} timed out after ${timeoutMs}ms`, {
    cmd: command,
    timeoutMs,
  });
}
