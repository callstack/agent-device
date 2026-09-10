import { beforeEach, describe, expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecOptions } from '../host.ts';
import {
  createRunnerPhaseBudget,
  diffComparableRunnerCacheMetadata,
  resolveRunnerBundleBuildSettings,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerSigningBuildSettings,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveExpectedRunnerCacheMetadata,
} from '../runner-cache-metadata.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../apple-runner-platform.ts';
import { appleToolchainProbeResult, stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';

const runCmdSync = stubAppleToolchainProbes();

test('resolveRunnerMaxConcurrentDestinationsFlag uses simulator flag for simulators', () => {
  assert.equal(
    resolveRunnerMaxConcurrentDestinationsFlag(IOS_SIMULATOR),
    '-maximum-concurrent-test-simulator-destinations',
  );
});

test('resolveRunnerMaxConcurrentDestinationsFlag uses device flag for physical devices', () => {
  assert.equal(
    resolveRunnerMaxConcurrentDestinationsFlag(IOS_DEVICE),
    '-maximum-concurrent-test-device-destinations',
  );
});

test('resolveRunnerMaxConcurrentDestinationsFlag uses device flag for macOS desktop', () => {
  assert.equal(
    resolveRunnerMaxConcurrentDestinationsFlag(MACOS_DEVICE),
    '-maximum-concurrent-test-device-destinations',
  );
});

test('resolveRunnerSigningBuildSettings returns empty args without env overrides', () => {
  assert.deepEqual(resolveRunnerSigningBuildSettings({}), []);
});

test('resolveRunnerSigningBuildSettings disables signing for macOS desktop builds', () => {
  assert.deepEqual(
    resolveRunnerSigningBuildSettings({}, true, {
      platform: 'apple',
      appleOs: 'macos',
    }),
    [
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGN_IDENTITY=',
      'DEVELOPMENT_TEAM=',
    ],
  );
});

test('resolveRunnerSigningBuildSettings enables automatic signing for device builds without forcing identity', () => {
  assert.deepEqual(resolveRunnerSigningBuildSettings({}, true), ['CODE_SIGN_STYLE=Automatic']);
});

test('resolveRunnerSigningBuildSettings ignores device signing overrides for simulator builds', () => {
  assert.deepEqual(
    resolveRunnerSigningBuildSettings(
      {
        AGENT_DEVICE_IOS_TEAM_ID: 'ABCDE12345',
        AGENT_DEVICE_IOS_SIGNING_IDENTITY: 'Apple Development',
        AGENT_DEVICE_IOS_PROVISIONING_PROFILE: 'My Profile',
      },
      false,
    ),
    [],
  );
});

test('resolveRunnerSigningBuildSettings applies optional overrides when provided', () => {
  const settings = resolveRunnerSigningBuildSettings(
    {
      AGENT_DEVICE_IOS_TEAM_ID: 'ABCDE12345',
      AGENT_DEVICE_IOS_SIGNING_IDENTITY: 'Apple Development',
      AGENT_DEVICE_IOS_PROVISIONING_PROFILE: 'My Profile',
    },
    true,
  );
  assert.deepEqual(settings, [
    'CODE_SIGN_STYLE=Manual',
    'DEVELOPMENT_TEAM=ABCDE12345',
    'CODE_SIGN_IDENTITY=Apple Development',
    'PROVISIONING_PROFILE_SPECIFIER=My Profile',
  ]);
});

test('resolveRunnerSigningBuildSettings switches to manual signing when a profile is set without team or identity', () => {
  const settings = resolveRunnerSigningBuildSettings(
    { AGENT_DEVICE_IOS_PROVISIONING_PROFILE: 'My Profile' },
    true,
  );
  assert.deepEqual(settings, [
    'CODE_SIGN_STYLE=Manual',
    'PROVISIONING_PROFILE_SPECIFIER=My Profile',
  ]);
});

test('resolveRunnerPerformanceBuildSettings disables indexing and code coverage', () => {
  assert.deepEqual(resolveRunnerPerformanceBuildSettings(), [
    'COMPILER_INDEX_STORE_ENABLE=NO',
    'ENABLE_CODE_COVERAGE=NO',
    'ONLY_ACTIVE_ARCH=YES',
    'ENABLE_PREVIEWS=NO',
    'ENABLE_DEBUG_DYLIB=NO',
  ]);
});

test('resolveRunnerSandboxBuildArgs disables nested Xcode and Swift sandboxing', () => {
  assert.deepEqual(resolveRunnerSandboxBuildArgs(), [
    '-IDEPackageSupportDisableManifestSandbox=1',
    '-IDEPackageSupportDisablePluginExecutionSandbox=1',
    'ENABLE_USER_SCRIPT_SANDBOXING=NO',
    'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox',
  ]);
});

test('resolveRunnerSandboxBuildArgs includes Swift runner unit tests only when requested', () => {
  const previous = process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS;
  try {
    process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS = '1';
    assert.deepEqual(resolveRunnerSandboxBuildArgs(), [
      '-IDEPackageSupportDisableManifestSandbox=1',
      '-IDEPackageSupportDisablePluginExecutionSandbox=1',
      'ENABLE_USER_SCRIPT_SANDBOXING=NO',
      'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_UNIT_TESTS',
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS;
    } else {
      process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS = previous;
    }
  }
});

test('resolveRunnerBundleBuildSettings returns default bundle identifiers', () => {
  assert.deepEqual(resolveRunnerBundleBuildSettings({}), [
    'AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=com.callstack.agentdevice.runner',
    'AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.callstack.agentdevice.runner.uitests',
  ]);
});

test('resolveRunnerBundleBuildSettings uses AGENT_DEVICE_IOS_BUNDLE_ID when provided', () => {
  assert.deepEqual(
    resolveRunnerBundleBuildSettings({
      AGENT_DEVICE_IOS_BUNDLE_ID: 'com.example.agent-device.runner',
    }),
    [
      'AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=com.example.agent-device.runner',
      'AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.example.agent-device.runner.uitests',
    ],
  );
});

test('metadata diff names only the comparable keys that differ, with expected and actual', () => {
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  const actual = {
    ...expected,
    packageVersion: `${expected.packageVersion}-next`,
    xcodeBuildVersion: '17A100',
    runnerPerformanceBuildSettings: ['ENABLE_CODE_COVERAGE=YES'],
    artifacts: {
      xctestrunPath: '/tmp/derived/Runner.xctestrun',
      xctestrunMtimeMs: 1,
      xctestrunSize: 2,
      productPaths: [{ path: '/tmp/derived/Runner.app', mtimeMs: 1, size: 2 }],
    },
  };

  assert.deepEqual(diffComparableRunnerCacheMetadata(expected, actual), [
    {
      key: 'runnerPerformanceBuildSettings',
      expected: JSON.stringify(expected.runnerPerformanceBuildSettings),
      actual: '["ENABLE_CODE_COVERAGE=YES"]',
    },
    { key: 'xcodeBuildVersion', expected: '"17C52"', actual: '"17A100"' },
  ]);
});

test('metadata diff reports a key only one side carries as absent', () => {
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  const { sdkBuildVersion: _sdkBuildVersion, ...withoutSdkBuildVersion } = expected;

  assert.deepEqual(
    diffComparableRunnerCacheMetadata(expected, withoutSdkBuildVersion as typeof expected),
    [{ key: 'sdkBuildVersion', expected: '"23C53"', actual: '(absent)' }],
  );
});

test('metadata diff is empty for identical metadata', () => {
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  assert.deepEqual(diffComparableRunnerCacheMetadata(expected, { ...expected }), []);
});

test('metadata diff elides an over-long value in the middle so both ends stay comparable', () => {
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  const longSetting = (suffix: string) => [`${'A'.repeat(400)}=${suffix}`];

  const [difference] = diffComparableRunnerCacheMetadata(
    { ...expected, runnerBundleBuildSettings: longSetting('one') },
    { ...expected, runnerBundleBuildSettings: longSetting('two') },
  );

  assert.equal(difference?.key, 'runnerBundleBuildSettings');
  assert.ok((difference?.expected.length ?? 0) <= 300);
  assert.ok(difference?.expected.startsWith('["AAA'));
  assert.ok(difference?.expected.endsWith('=one"]'));
  assert.ok(difference?.actual.endsWith('=two"]'));
});

function unavailableProbes(): { probe: string; reason: string }[] {
  try {
    resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
    return [];
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'apple_toolchain_probe_unavailable');
    const probes = error.details?.probes as { probe: string; reason: string }[];
    return probes.map(({ probe, reason }) => ({ probe, reason }));
  }
}

test('a timed-out probe leaves the toolchain unavailable instead of a comparable value', () => {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) => {
    if (command === 'xcodebuild') {
      throw new AppError('COMMAND_FAILED', 'xcodebuild timed out after 5000ms', {
        timeoutMs: 5_000,
      });
    }
    return appleToolchainProbeResult(command, args);
  });

  assert.deepEqual(unavailableProbes(), [{ probe: 'xcodebuild -version', reason: 'probe_error' }]);
});

// Apple's syspolicyd signature scan blocks the first xcodebuild/xcrun exec
// after a fresh macOS host boots for roughly 18 to 19 seconds; the immediate
// next exec of the same tool is instant (#2422). These cases exercise the
// resulting one-retry policy, and the budget that bounds it, without waiting
// on a real cold-start stall: the fake clock only moves when a probe actually
// blocks for the timeout it was given, so a case that claims the budget was
// spent had to spend it.
describe('toolchain probe budget', () => {
  // Failures are never memoized, but the recovery case below succeeds; each
  // case starts from an empty toolchain fingerprint cache so none of them
  // reads another's answer.
  beforeEach(resetAllProcessMemosForTests);

  test('a cold-start probe recovers on retry, and the stall it survived is charged to the budget', () => {
    const clock = installFakeToolchainClock();
    const xcodebuildTimeouts: number[] = [];
    runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
      if (command !== 'xcodebuild') return appleToolchainProbeResult(command, args);
      xcodebuildTimeouts.push(options.timeoutMs ?? 0);
      if (xcodebuildTimeouts.length > 1) return appleToolchainProbeResult(command, args);
      throw blockForWholeTimeout(clock, command, args, options);
    });
    runCmdSync.mockClear();

    const metadata = resolveExpectedRunnerCacheMetadata(IOS_DEVICE);

    assert.equal(metadata.xcodeVersion, '26.2');
    assert.equal(metadata.xcodeBuildVersion, '17C52');
    // The retry runs on what the shared budget has left, not on a fresh
    // per-call ceiling: 45 s total minus the 30 s the first attempt burned.
    assert.deepEqual(xcodebuildTimeouts, [COLD_TOOLCHAIN_PROBE_TIMEOUT_MS, 15_000]);
  });

  test('an owning phase with 4 s left gets one 4 s attempt and no retry', () => {
    const clock = installFakeToolchainClock();
    const phaseBudget = createRunnerPhaseBudget(4_000, undefined);
    runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
      throw blockForWholeTimeout(clock, command, args, options);
    });
    runCmdSync.mockClear();

    assert.throws(
      () => resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR, undefined, phaseBudget),
      (error: unknown) => expectRunnerPhaseBudgetExhausted(error),
    );
    assert.equal(runCmdSync.mock.calls.length, 1);
    // The one attempt was capped by the phase, not by the 30 s per-call ceiling.
    assert.equal(runCmdSync.mock.calls[0]?.[2]?.timeoutMs, 4_000);
    assert.equal(clock.nowMs, 4_000);
  });

  test('a probe that failed on its own and merely says "timed out" in its message is not retried', () => {
    installFakeToolchainClock();
    runCmdSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'xcodebuild') return appleToolchainProbeResult(command, args);
      // No `timeoutMs` detail: this is the tool reporting its own failure, not
      // the exec layer killing it at a timeout we asked for.
      throw new AppError('COMMAND_FAILED', 'xcodebuild timed out after 10ms', {
        cmd: command,
        args,
      });
    });
    runCmdSync.mockClear();

    assert.throws(
      () => resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        expect(error.message).toContain('xcodebuild timed out after 10ms');
        return true;
      },
    );
    expect(runCmdSync.mock.calls.filter(([command]) => command === 'xcodebuild')).toHaveLength(1);
  });

  /**
   * One row per way a fingerprint read can be interrupted: when the owning request aborts,
   * what the probe that abort lands on does, and what the phase must then surface.
   * `spawnSync` cannot be interrupted once it has started, so a cancellation is only ever
   * observed between attempts -- the exec count is what pins which attempt each row stopped.
   */
  type ToolchainProbeCancellationCase = {
    label: string;
    /** Which execs refuse to answer, and how they end; every other exec answers. */
    failing?: { at: 'first' | 'final' | 'every'; as: 'exec-timeout' | 'command-failure' };
    /**
     * When the owning request aborts: never, before the phase runs a probe at all, while
     * the failing exec is still blocked, or as that exec's timeout unwinds.
     */
    aborts: 'never' | 'before-any-probe' | 'while-it-blocks' | 'as-it-unwinds';
    /** Whether the process-wide fingerprint memo already holds an answer. */
    fingerprintCache?: 'warm';
    expected: 'request-canceled' | 'budget-exhausted' | 'fingerprint';
    /** Execs the phase is allowed to have run by the time it settles. */
    execs: number;
    /** Wall clock the phase spent: only an exec that blocks for its whole timeout moves it. */
    clockMs: number;
  };

  const CANCELLATION_CASES: ToolchainProbeCancellationCase[] = [
    {
      label: 'aborted before the first probe, cold cache',
      aborts: 'before-any-probe',
      expected: 'request-canceled',
      execs: 0,
      clockMs: 0,
    },
    {
      // A cache hit must not answer a request that is already gone (#2422 round 4).
      label: 'aborted before the first probe, fingerprint cache warm',
      aborts: 'before-any-probe',
      fingerprintCache: 'warm',
      expected: 'request-canceled',
      execs: 0,
      clockMs: 0,
    },
    {
      label: 'aborted while the first probe blocks, and it then times out',
      failing: { at: 'first', as: 'exec-timeout' },
      aborts: 'while-it-blocks',
      expected: 'request-canceled',
      execs: 1,
      clockMs: COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
    },
    {
      label: 'aborted while the first probe fails with a non-timeout error',
      failing: { at: 'first', as: 'command-failure' },
      aborts: 'while-it-blocks',
      expected: 'request-canceled',
      execs: 1,
      clockMs: 0,
    },
    {
      // The budget still had 15 s: only the cancellation stops the retry.
      label: "aborted as the first attempt's timeout unwinds, before its retry",
      failing: { at: 'first', as: 'exec-timeout' },
      aborts: 'as-it-unwinds',
      expected: 'request-canceled',
      execs: 1,
      clockMs: COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
    },
    {
      // Nothing is left to catch the cancellation on a later attempt, so the failing
      // probe's own catch must: an unavailable toolchain would be the wrong verdict.
      label: 'aborted while the final probe fails with a non-timeout error',
      failing: { at: 'final', as: 'command-failure' },
      aborts: 'while-it-blocks',
      expected: 'request-canceled',
      execs: 3,
      clockMs: 0,
    },
    {
      label: 'aborted while the final probe blocks, and it then times out',
      failing: { at: 'final', as: 'exec-timeout' },
      aborts: 'while-it-blocks',
      expected: 'request-canceled',
      execs: 3,
      clockMs: COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
    },
    {
      // 30 s plus a 15 s retry spends the whole 45 s ceiling on the first probe. The two
      // xcrun probes never ran, so the verdict is the budget, not an unreadable toolchain:
      // an `xcode-select` hint here would point at the wrong thing.
      label: 'never aborted, the first probe and its retry spend the whole budget',
      failing: { at: 'every', as: 'exec-timeout' },
      aborts: 'never',
      expected: 'budget-exhausted',
      execs: 2,
      clockMs: 45_000,
    },
    {
      label: 'never aborted, the first probe times out and its retry recovers',
      failing: { at: 'first', as: 'exec-timeout' },
      aborts: 'never',
      expected: 'fingerprint',
      execs: 4,
      clockMs: COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
    },
  ];

  test.each(CANCELLATION_CASES)('cancellation matrix: $label', (testCase) => {
    const clock = installFakeToolchainClock();
    const request = new AbortController();
    if (testCase.fingerprintCache === 'warm') {
      runCmdSync.mockImplementation(appleToolchainProbeResult);
      resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
    }
    if (testCase.aborts === 'before-any-probe') request.abort();

    let execs = 0;
    runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
      execs += 1;
      if (!failsOnExec(testCase, execs)) return appleToolchainProbeResult(command, args);
      if (testCase.aborts === 'while-it-blocks') request.abort();
      const failure =
        testCase.failing?.as === 'exec-timeout'
          ? blockForWholeTimeout(clock, command, args, options)
          : // No `timeoutMs` detail: the tool failed on its own, so nothing retries it.
            new AppError('COMMAND_FAILED', `${command}: unexpected error`, { cmd: command, args });
      if (testCase.aborts === 'as-it-unwinds') request.abort();
      throw failure;
    });

    const readFingerprint = () =>
      resolveExpectedRunnerCacheMetadata(
        IOS_SIMULATOR,
        undefined,
        createRunnerPhaseBudget(undefined, request.signal),
      );

    if (testCase.expected === 'fingerprint') {
      const metadata = readFingerprint();
      assert.equal(metadata.xcodeVersion, '26.2', testCase.label);
      assert.equal(metadata.xcodeBuildVersion, '17C52', testCase.label);
    } else {
      assert.throws(readFingerprint, (error: unknown) => {
        assert.ok(
          testCase.expected === 'request-canceled'
            ? isRequestCanceledError(error)
            : expectRunnerPhaseBudgetExhausted(error),
          `${testCase.label}: expected ${testCase.expected}, got ${String(error)}`,
        );
        return true;
      });
    }
    assert.equal(execs, testCase.execs, `${testCase.label}: exec count`);
    assert.equal(clock.nowMs, testCase.clockMs, `${testCase.label}: wall clock spent`);
  });

  /** Which exec a row's failing probe is: the first, the last of the three, or all of them. */
  function failsOnExec(testCase: ToolchainProbeCancellationCase, exec: number): boolean {
    switch (testCase.failing?.at) {
      case 'first':
        return exec === 1;
      case 'final':
        return exec === 3;
      case 'every':
        return true;
      default:
        return false;
    }
  }
});

/** The error a runner phase raises when a step is reached with nothing left to spend. */
function expectRunnerPhaseBudgetExhausted(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.reason, 'runner_phase_budget_exhausted');
  assert.equal(error.details?.phase, 'apple_toolchain_probe');
  assert.equal(error.details?.retriable, true);
  expect(error.message).toContain('budget ran out');
  return true;
}

/**
 * A clock the probes' own budget reads, advanced only by
 * {@link blockForWholeTimeout}. Without it a mock that throws immediately
 * proves nothing about a deadline: no time passes, so every budget looks
 * untouched however many attempts run.
 */
function installFakeToolchainClock(): { nowMs: number } {
  const clock = { nowMs: 0 };
  appleRunnerTestHost.update({
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
  return clock;
}

/** A probe that blocked for its whole timeout and was then killed, as the exec layer reports it. */
function blockForWholeTimeout(
  clock: { nowMs: number },
  command: string,
  args: string[],
  options: ExecOptions,
): AppError {
  const timeoutMs = options.timeoutMs ?? 0;
  clock.nowMs += timeoutMs;
  return new AppError('COMMAND_FAILED', `${command} timed out after ${timeoutMs}ms`, {
    cmd: command,
    args,
    timeoutMs,
  });
}

test('a failing probe reports its exit status rather than a fabricated SDK version', () => {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
    command === 'xcrun'
      ? {
          exitCode: 70,
          stdout: '',
          stderr: 'xcrun: error: SDK cannot be located\n',
        }
      : appleToolchainProbeResult(command, args),
  );

  assert.deepEqual(unavailableProbes(), [
    {
      probe: 'xcrun --sdk iphonesimulator --show-sdk-version',
      reason: 'nonzero_exit',
    },
    {
      probe: 'xcrun --sdk iphonesimulator --show-sdk-build-version',
      reason: 'nonzero_exit',
    },
  ]);
});

test('unrecognized xcodebuild output is unavailable, not a partially parsed fingerprint', () => {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
    command === 'xcodebuild'
      ? {
          exitCode: 0,
          stdout: 'xcode-select: error: tool not configured\n',
          stderr: '',
        }
      : appleToolchainProbeResult(command, args),
  );

  assert.deepEqual(unavailableProbes(), [
    { probe: 'xcodebuild -version', reason: 'unparsable_output' },
  ]);
});

test('an empty probe answer is unavailable rather than an empty cache key field', () => {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
    command === 'xcrun' && args.includes('--show-sdk-build-version')
      ? { exitCode: 0, stdout: '\n', stderr: '' }
      : appleToolchainProbeResult(command, args),
  );

  assert.deepEqual(unavailableProbes(), [
    {
      probe: 'xcrun --sdk iphonesimulator --show-sdk-build-version',
      reason: 'empty_output',
    },
  ]);
});

test('an unavailable toolchain fails the cache decision with a retriable typed error', () => {
  runCmdSync.mockImplementation(() => {
    throw new AppError('COMMAND_FAILED', 'xcodebuild timed out after 5000ms', {});
  });

  try {
    resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
    assert.fail('expected an unavailable toolchain to fail the cache decision');
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.details?.retriable, true);
    expect(error.message).toContain('xcodebuild -version');
    expect(String(error.details?.hint)).toContain('xcode-select');
  }
});

test('an unavailable probe never reaches cache metadata, and is not memoized as one', () => {
  runCmdSync.mockImplementation(() => {
    throw new AppError('COMMAND_FAILED', 'xcodebuild timed out after 5000ms', {});
  });
  expect(() => resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR)).toThrow(
    /Could not read the Xcode toolchain versions/,
  );

  runCmdSync.mockImplementation(appleToolchainProbeResult);
  const metadata = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  assert.equal(metadata.xcodeVersion, '26.2');
  assert.equal(metadata.xcodeBuildVersion, '17C52');
  assert.equal(metadata.sdkVersion, '26.2');
  assert.equal(metadata.sdkBuildVersion, '23C53');
});

test('a malformed xcodebuild answer is not memoized: the next request re-probes and recovers', () => {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
    command === 'xcodebuild'
      ? {
          exitCode: 0,
          stdout: 'xcode-select: error: tool not configured\n',
          stderr: '',
        }
      : appleToolchainProbeResult(command, args),
  );
  assert.deepEqual(unavailableProbes(), [
    { probe: 'xcodebuild -version', reason: 'unparsable_output' },
  ]);
  const probeCallsWhileMalformed = runCmdSync.mock.calls.length;

  runCmdSync.mockImplementation(appleToolchainProbeResult);
  const metadata = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  assert.equal(metadata.xcodeVersion, '26.2');
  assert.equal(metadata.xcodeBuildVersion, '17C52');
  expect(runCmdSync.mock.calls.slice(probeCallsWhileMalformed).map(([command]) => command)).toEqual(
    ['xcodebuild', 'xcrun', 'xcrun'],
  );
});

test('only a complete, parsed toolchain fingerprint is memoized', () => {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
    command === 'xcrun' && args.includes('--show-sdk-build-version')
      ? { exitCode: 0, stdout: '\n', stderr: '' }
      : appleToolchainProbeResult(command, args),
  );
  assert.deepEqual(unavailableProbes(), [
    {
      probe: 'xcrun --sdk iphonesimulator --show-sdk-build-version',
      reason: 'empty_output',
    },
  ]);

  runCmdSync.mockImplementation(appleToolchainProbeResult);
  runCmdSync.mockClear();
  const first = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  // The healthy xcodebuild answer from the failed round was not kept either: all three re-run.
  expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual([
    'xcodebuild',
    'xcrun',
    'xcrun',
  ]);

  runCmdSync.mockClear();
  const second = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  expect(runCmdSync).not.toHaveBeenCalled();
  assert.deepEqual(
    [second.xcodeVersion, second.xcodeBuildVersion, second.sdkVersion, second.sdkBuildVersion],
    [first.xcodeVersion, first.xcodeBuildVersion, first.sdkVersion, first.sdkBuildVersion],
  );
});
