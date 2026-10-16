import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  appleToolchainProbeResult,
  blockForWholeTimeout,
  installToolchainProbeClock,
  selectedDeveloperDirResult,
  STUBBED_APPLE_TOOLCHAIN,
  valueProbeCommands,
} from './apple-toolchain-fixtures.ts';
import {
  memoizedRunnerXcodeVersion,
  requireRunnerToolchainFingerprint,
} from '../runner-toolchain-probe.ts';
import { createRunnerPhaseBudget, type RunnerPhaseBudget } from '../runner-phase-budget.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../apple-runner-platform.ts';

// The fingerprint memo is process-wide and the selection it keys on is host state, so these cases
// script both: `xcode-select -p` answers `selectedDeveloperDir`, and `xcodebuild` names the Xcode
// belonging to that selection.
const XCODE_A = '/Applications/Xcode-A.app/Contents/Developer';
const XCODE_B = '/Applications/Xcode-B.app/Contents/Developer';
const IPHONESIMULATOR_SDK = 'iphonesimulator';
const XCODE_B_BUILD_VERSION = '18A100';
const FINGERPRINT_TTL_MS = 10 * 60_000;
/** The ceiling one `xcode-select -p` attempt gets, below the 30 s a value probe gets. */
const XCODE_SELECT_TIMEOUT_MS = 2_000;

const runCmdSync = vi.fn();
let selectedDeveloperDir = XCODE_A;
let nowMs = 1_700_000_000_000;

beforeEach(() => {
  resetAllProcessMemosForTests();
  selectedDeveloperDir = XCODE_A;
  runCmdSync.mockReset().mockImplementation(appleToolchainProbeResult);
  appleRunnerTestHost.update({
    runCmdSync,
    commandDeveloperDir: () => undefined,
  });
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Two Xcodes and the `sudo xcode-select -s` that moves the host's default selection between them. */
function scriptSelectableXcodes(): void {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
    command === 'xcode-select'
      ? selectedDeveloperDirResult(selectedDeveloperDir)
      : command === 'xcodebuild' && selectedDeveloperDir === XCODE_B
        ? {
            exitCode: 0,
            stdout: `Xcode 27.0\nBuild version ${XCODE_B_BUILD_VERSION}\n`,
            stderr: '',
          }
        : appleToolchainProbeResult(command, args),
  );
}

function readFingerprint(
  budget?: RunnerPhaseBudget,
): ReturnType<typeof requireRunnerToolchainFingerprint> {
  return requireRunnerToolchainFingerprint(IPHONESIMULATOR_SDK, budget);
}

function attemptedTimeoutMs(command: string): number | undefined {
  const call = runCmdSync.mock.calls.find(([executed]) => executed === command);
  return (call?.[2] as ExecOptions | undefined)?.timeoutMs;
}

function blockResolutionForWholeTimeout(clock: { nowMs: number }): void {
  runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
    if (command !== 'xcode-select') return appleToolchainProbeResult(command, args);
    throw blockForWholeTimeout(clock, command, args, options);
  });
}

describe('the developer dir a toolchain fingerprint answers for', () => {
  test('a default selection that moved re-reads instead of answering the Xcode it replaced', () => {
    scriptSelectableXcodes();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    selectedDeveloperDir = XCODE_B;
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(XCODE_B_BUILD_VERSION);

    // The switch costs one resolution and one full re-read. The entry keyed on the old dir cannot
    // answer for the new one, which is what let a daemon serve the Xcode the host had left (#3300).
    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual([
      'xcode-select',
      'xcodebuild',
      'xcrun',
      'xcrun',
    ]);
  });

  test('a selection that comes back to a dir answers from that dir, not from the one it left', () => {
    scriptSelectableXcodes();
    readFingerprint();
    selectedDeveloperDir = XCODE_B;
    readFingerprint();

    selectedDeveloperDir = XCODE_A;
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual([]);
  });

  test('each read resolves the selection it keys on, and one resolution is enough', () => {
    readFingerprint();
    runCmdSync.mockClear();

    readFingerprint();

    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual(['xcode-select']);
  });

  test('a failure report names the Xcode of the selection this process resolved last', () => {
    scriptSelectableXcodes();
    readFingerprint();
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);

    selectedDeveloperDir = XCODE_B;
    readFingerprint();
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe('27.0');

    // Naming a selection is not worth waiting on one: only a fingerprint read resolves it.
    runCmdSync.mockClear();
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe('27.0');
    expect(runCmdSync.mock.calls).toEqual([]);
  });

  test('a selection that comes back to a dir answers its report from that dir as well', () => {
    scriptSelectableXcodes();
    readFingerprint();
    selectedDeveloperDir = XCODE_B;
    readFingerprint();

    selectedDeveloperDir = XCODE_A;
    // The read itself is a hit on A's entry, so it stores nothing; the report pointer still has to
    // follow the selection this read resolved, or it would blame B for an A-backed runner (#3300).
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  });

  test('a client that chooses DEVELOPER_DIR keys its read without resolving the default', () => {
    scriptSelectableXcodes();
    appleRunnerTestHost.update({ commandDeveloperDir: () => XCODE_A });

    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    expect(runCmdSync.mock.calls).toEqual([]);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  });

  test('a read that fails on its probes leaves a report naming the selection that stored one', () => {
    scriptSelectableXcodes();
    readFingerprint();

    selectedDeveloperDir = XCODE_B;
    runCmdSync.mockImplementation((command: string) =>
      command === 'xcode-select'
        ? selectedDeveloperDirResult(XCODE_B)
        : { exitCode: 1, stdout: '', stderr: 'xcodebuild: no such tool\n' },
    );
    expect(() => readFingerprint()).toThrow(/Could not read the Xcode toolchain versions/);

    // XCODE_B stored nothing, so the only report still owed an answer is the one made under XCODE_A.
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  });

  test('a selection that will not resolve reads a fingerprint and caches nothing for it', () => {
    const unresolvable = (): ExecResult => ({
      exitCode: 72,
      stdout: '',
      stderr: 'xcode-select: error: no developer directory\n',
    });
    runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
      command === 'xcode-select' ? unresolvable() : appleToolchainProbeResult(command, args),
    );

    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    runCmdSync.mockClear();
    // Nothing is cached under an unknown dir: the next read cannot tell which Xcode the entry would
    // answer for, so it pays the probes again rather than risking another selection's answer.
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual([
      'xcode-select',
      'xcodebuild',
      'xcrun',
      'xcrun',
    ]);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBeUndefined();
  });

  test('a selection that answers nothing, or dies on exec, is no dir rather than a bad one', () => {
    for (const unanswered of [
      { exitCode: 0, stdout: '   \n', stderr: '' } satisfies ExecResult,
      null,
    ]) {
      runCmdSync.mockImplementation((command: string, args: readonly string[]) => {
        if (command !== 'xcode-select') return appleToolchainProbeResult(command, args);
        if (!unanswered) throw new Error('ENOENT: xcode-select not found');
        return unanswered;
      });
      expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    }

    expect(runCmdSync.mock.calls.filter(([command]) => command === 'xcode-select')).toHaveLength(2);
  });

  test('a default-selection read keys on what the resolution answers, not on a dir it saw before', () => {
    scriptSelectableXcodes();
    appleRunnerTestHost.update({ commandDeveloperDir: () => XCODE_A });
    readFingerprint();

    selectedDeveloperDir = XCODE_B;
    appleRunnerTestHost.update({ commandDeveloperDir: () => undefined });
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(XCODE_B_BUILD_VERSION);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);

    // The resolution is what puts this read back on the client-dir entry: without believing its
    // answer, a selection that came home would re-probe a toolchain this process already knows.
    selectedDeveloperDir = XCODE_A;
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual([]);
  });
});

describe('the budget and cancellation a default-selection resolution answers to', () => {
  test('a resolution is capped below the value probe whose entry it decides', () => {
    readFingerprint();

    expect(attemptedTimeoutMs('xcode-select')).toBe(XCODE_SELECT_TIMEOUT_MS);
    expect(attemptedTimeoutMs('xcodebuild')).toBe(COLD_TOOLCHAIN_PROBE_TIMEOUT_MS);
  });

  test('an owning phase leaves the resolution half of what it has and no more', () => {
    installToolchainProbeClock();

    readFingerprint(createRunnerPhaseBudget(1_200, undefined));

    expect(attemptedTimeoutMs('xcode-select')).toBe(600);
  });

  test('a stalled resolution spends its own ceiling and never the fingerprint behind it', () => {
    const clock = installToolchainProbeClock();
    blockResolutionForWholeTimeout(clock);

    const fingerprint = readFingerprint();

    // A stalled `xcode-select` is a host not saying which Xcode it means, so the read continues
    // with no dir and pays for the whole fingerprint: the optional probe cannot cost the answer.
    expect(fingerprint.xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(clock.nowMs).toBe(XCODE_SELECT_TIMEOUT_MS);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
  });

  test('a stalled resolution costs a cold-start retry its headroom, and only that', () => {
    const clock = installToolchainProbeClock();
    const xcodebuildTimeouts: number[] = [];
    runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
      if (command === 'xcode-select') throw blockForWholeTimeout(clock, command, args, options);
      if (command !== 'xcodebuild') return appleToolchainProbeResult(command, args);
      xcodebuildTimeouts.push(options.timeoutMs ?? 0);
      if (xcodebuildTimeouts.length > 1) return appleToolchainProbeResult(command, args);
      throw blockForWholeTimeout(clock, command, args, options);
    });

    const fingerprint = readFingerprint();

    // The same cold-start stall the budget is sized around, on a read that also lost 2 s deciding
    // its key: the retry runs on what is left, so one ceiling still bounds the whole fingerprint.
    expect(fingerprint.xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(xcodebuildTimeouts).toEqual([
      COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
      45_000 - COLD_TOOLCHAIN_PROBE_TIMEOUT_MS - XCODE_SELECT_TIMEOUT_MS,
    ]);
    expect(clock.nowMs).toBe(COLD_TOOLCHAIN_PROBE_TIMEOUT_MS + XCODE_SELECT_TIMEOUT_MS);
  });

  for (const cache of ['cold', 'warm'] as const) {
    test(`a request aborted while the resolution blocks is canceled with a ${cache} cache`, () => {
      const request = new AbortController();
      if (cache === 'warm') {
        readFingerprint();
        runCmdSync.mockClear();
      }
      runCmdSync.mockImplementation((command: string) => {
        if (command === 'xcode-select') {
          request.abort();
          throw new Error('spawnSync was killed');
        }
        throw new Error(`no value probe may run once the resolution was aborted: ${command}`);
      });

      try {
        readFingerprint(createRunnerPhaseBudget(undefined, request.signal));
        assert.fail('expected the aborted request to be canceled at the resolution');
      } catch (error) {
        assert.ok(isRequestCanceledError(error), `got ${String(error)}`);
      }
      assert.deepEqual(
        runCmdSync.mock.calls.filter(([command]) => command !== 'xcode-select').flat(),
        [],
      );
    });
  }
});

describe('the lifetime of a memoized toolchain fingerprint', () => {
  function advance(ms: number): void {
    nowMs += ms;
  }

  test('a hit answers to the end of the TTL its read started, and no longer', () => {
    readFingerprint();

    // Hits used to push expiry ahead of themselves, so a daemon reading more often than the TTL
    // never re-resolved its selection at all (#3300).
    advance(FINGERPRINT_TTL_MS / 2);
    runCmdSync.mockClear();
    readFingerprint();
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual([]);

    advance(FINGERPRINT_TTL_MS / 2);
    runCmdSync.mockClear();
    readFingerprint();
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
  });

  test('a hit well inside the TTL answers the read without touching the toolchain', () => {
    readFingerprint();
    runCmdSync.mockClear();

    advance(FINGERPRINT_TTL_MS / 4);
    readFingerprint();

    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual(['xcode-select']);
  });

  test('a fingerprint expired under one selection is read again under the current one', () => {
    scriptSelectableXcodes();
    readFingerprint();
    selectedDeveloperDir = XCODE_B;

    advance(FINGERPRINT_TTL_MS);
    runCmdSync.mockClear();
    readFingerprint();

    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual([
      'xcode-select',
      'xcodebuild',
      'xcrun',
      'xcrun',
    ]);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe('27.0');
  });
});
