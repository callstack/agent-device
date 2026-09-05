import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import {
  diffComparableRunnerCacheMetadata,
  resolveRunnerBundleBuildSettings,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerSigningBuildSettings,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveExpectedRunnerCacheMetadata,
} from '../runner-cache-metadata.ts';
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
