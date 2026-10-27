import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  requireRunnerBuildSettingsMatchBuildLog,
  diffComparableRunnerCacheMetadata,
  resolveRunnerBundleBuildSettings,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerSigningBuildSettings,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
} from '../runner-cache-metadata.ts';
import { createRunnerPhaseBudget } from '../runner-phase-budget.ts';
import { STUBBED_APPLE_TOOLCHAIN, writeXcodeFixture } from './apple-toolchain-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { xcodebuildLogWithBuildArguments } from './runner-build-log.fixtures.ts';
import { withoutRunnerDerivedPathEnv } from './runner-xctestrun.fixtures.ts';

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
    'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY',
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
      'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY -D AGENT_DEVICE_RUNNER_UNIT_TESTS',
      'OTHER_CFLAGS=$(inherited) -D AGENT_DEVICE_RUNNER_UNIT_TESTS',
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
      xctestrunSize: 2,
      xctestrunDigest: 'a'.repeat(64),
      productPaths: ['/tmp/derived/Runner.app'],
      entries: [{ path: 'Runner.app/Runner', size: 2, mode: 0o755, digest: 'b'.repeat(64) }],
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

function recordedRunnerBuildArguments(): string[] {
  const metadata = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  return [
    ...metadata.runnerBundleBuildSettings,
    ...metadata.runnerSigningBuildSettings,
    ...metadata.runnerPerformanceBuildSettings,
    ...metadata.runnerArchBuildSettings,
    ...metadata.runnerSandboxBuildArgs,
  ];
}

function writeRunnerBuildLog(root: string, args: readonly string[]): string {
  const logPath = path.join(root, 'agent-device-build-for-testing.log');
  fs.writeFileSync(logPath, xcodebuildLogWithBuildArguments(args));
  return logPath;
}

test('a build log holding the recorded recipe certifies the build', () => {
  const root = mkdtempForTestSync('runner-build-log-');
  const metadata = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  const logPath = writeRunnerBuildLog(root, recordedRunnerBuildArguments());

  assert.doesNotThrow(() => requireRunnerBuildSettingsMatchBuildLog(metadata, logPath));
});

test('a build log missing a recorded package-sandbox flag fails the check', () => {
  const root = mkdtempForTestSync('runner-build-log-');
  const metadata = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  // `-I` flags are not build settings, so the settings block would stay complete without them.
  const logPath = writeRunnerBuildLog(
    root,
    recordedRunnerBuildArguments().filter((arg) => !arg.startsWith('-IDEPackageSupport')),
  );

  assert.throws(
    () => requireRunnerBuildSettingsMatchBuildLog(metadata, logPath),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.deepEqual(
        (error.details as { differences: Array<{ key: string; expected: string }> }).differences
          .map((difference) => difference.expected)
          .sort(),
        [
          '-IDEPackageSupportDisableManifestSandbox=1',
          '-IDEPackageSupportDisablePluginExecutionSandbox=1',
        ],
      );
      return true;
    },
  );
});

test('an unreadable or setting-less build log fails the check', () => {
  const root = mkdtempForTestSync('runner-build-log-');
  const metadata = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  assert.throws(
    () =>
      requireRunnerBuildSettingsMatchBuildLog(metadata, path.join(root, 'never-written-build.log')),
    /did not use the settings its cache identity records/,
  );
});

test('the toolchain half of the key is read from the selected Xcode', () => {
  const metadata = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  assert.deepEqual(
    {
      xcodeVersion: metadata.xcodeVersion,
      xcodeBuildVersion: metadata.xcodeBuildVersion,
      sdkName: metadata.sdkName,
      sdkVersion: metadata.sdkVersion,
      sdkBuildVersion: metadata.sdkBuildVersion,
    },
    { ...STUBBED_APPLE_TOOLCHAIN, sdkName: 'iphonesimulator' },
  );
});

test('an unreadable toolchain fails the cache decision with a typed error naming the file', () => {
  const developerDir = writeXcodeFixture(mkdtempForTestSync('xcode-without-sdk-'));
  fs.rmSync(path.join(developerDir, 'Platforms/iPhoneSimulator.platform'), { recursive: true });
  appleRunnerTestHost.update({ commandDeveloperDir: () => developerDir });

  assert.throws(
    () => resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'apple_toolchain_unreadable' &&
      String(error.details?.file).endsWith('iPhoneSimulator.sdk/SDKSettings.json') &&
      error.details?.detail === 'ENOENT',
  );
});

test('an aborted owner is canceled before the toolchain is read', () => {
  const request = new AbortController();
  request.abort();
  assert.throws(
    () =>
      resolveExpectedRunnerCacheMetadata(
        IOS_SIMULATOR,
        undefined,
        createRunnerPhaseBudget(10_000, request.signal),
      ),
    (error: unknown) => isRequestCanceledError(error),
  );
});

test('a toolchain read under one DEVELOPER_DIR does not answer for another, so its runner is stale', () => {
  // An AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH override pins one path for every toolchain.
  withoutRunnerDerivedPathEnv();
  const xcodeA = writeXcodeFixture(mkdtempForTestSync('xcode-a-'));
  const xcodeB = writeXcodeFixture(mkdtempForTestSync('xcode-b-'), {
    ...STUBBED_APPLE_TOOLCHAIN,
    xcodeVersion: '27.0',
    xcodeBuildVersion: '18A100',
  });
  let developerDir = xcodeA;
  appleRunnerTestHost.update({ commandDeveloperDir: () => developerDir });

  const underA = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  developerDir = xcodeB;
  const underB = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  assert.equal(underA.xcodeBuildVersion, STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
  assert.equal(underB.xcodeBuildVersion, '18A100');
  // The derived path is what a retained runner is reused by, so a differing one makes it stale.
  assert.notEqual(
    resolveRunnerDerivedPath(IOS_SIMULATOR, underA),
    resolveRunnerDerivedPath(IOS_SIMULATOR, underB),
  );
});

test('an Xcode updated in place is read again rather than answered from before the update', () => {
  const developerDir = writeXcodeFixture(mkdtempForTestSync('xcode-in-place-'));
  appleRunnerTestHost.update({ commandDeveloperDir: () => developerDir });
  assert.equal(resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR).xcodeVersion, '26.2');

  writeXcodeFixture(path.resolve(developerDir, '../../..'), {
    ...STUBBED_APPLE_TOOLCHAIN,
    xcodeVersion: '26.3',
  });
  assert.equal(resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR).xcodeVersion, '26.3');
});
