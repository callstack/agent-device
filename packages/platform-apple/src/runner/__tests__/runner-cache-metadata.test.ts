import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import {
  resolveRunnerBundleBuildSettings,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerSigningBuildSettings,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveExpectedRunnerCacheMetadata,
} from '../runner-cache-metadata.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

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
    resolveRunnerSigningBuildSettings({}, true, { platform: 'apple', appleOs: 'macos' }),
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

test('runner cache metadata fingerprints shared snapshot presentation sources', () => {
  const root = mkdtempForTestSync('agent-device-runner-cache-fingerprint-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  fs.mkdirSync(path.join(root, 'apple', 'runner', 'AgentDeviceRunner'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apple', 'snapshot-presentation', 'Sources'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'apple', 'runner', 'AgentDeviceRunner', 'Runner.swift'),
    'runner\n',
  );
  const sharedSource = path.join(
    root,
    'apple',
    'snapshot-presentation',
    'Sources',
    'Presentation.swift',
  );
  fs.writeFileSync(sharedSource, 'shared-one\n');

  const before = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR, root).runnerSourceFingerprint;
  fs.writeFileSync(sharedSource, 'shared-two\n');
  const after = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR, root).runnerSourceFingerprint;

  assert.notEqual(after, before);
});

test('runner cache metadata ignores development-only SwiftPM trees but keeps runner unit tests', () => {
  const root = mkdtempForTestSync('agent-device-runner-cache-source-roots-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));

  const runnerRoot = path.join(root, 'apple', 'runner', 'AgentDeviceRunner');
  const runnerUnitTest = path.join(
    runnerRoot,
    'AgentDeviceRunnerUITests',
    'UnitTests',
    'Invariant.swift',
  );
  const sharedRoot = path.join(root, 'apple', 'snapshot-presentation');
  fs.mkdirSync(path.dirname(runnerUnitTest), { recursive: true });
  fs.mkdirSync(path.join(sharedRoot, 'Sources'), { recursive: true });
  fs.writeFileSync(path.join(runnerRoot, 'Runner.swift'), 'runner\n');
  fs.writeFileSync(runnerUnitTest, 'unit-one\n');
  fs.writeFileSync(path.join(sharedRoot, 'Sources', 'Presentation.swift'), 'shared\n');

  for (const directory of [
    'Tests',
    'SnapshotPresentationConformance',
    '.build',
    '.swiftpm',
    'xcuserdata',
  ]) {
    const file = path.join(sharedRoot, directory, 'Ignored.swift');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'ignored-one\n');
  }

  const before = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR, root).runnerSourceFingerprint;
  for (const directory of [
    'Tests',
    'SnapshotPresentationConformance',
    '.build',
    '.swiftpm',
    'xcuserdata',
  ]) {
    fs.writeFileSync(path.join(sharedRoot, directory, 'Ignored.swift'), 'ignored-two\n');
  }
  const afterIgnoredChanges = resolveExpectedRunnerCacheMetadata(
    IOS_SIMULATOR,
    root,
  ).runnerSourceFingerprint;
  assert.equal(afterIgnoredChanges, before);

  fs.writeFileSync(runnerUnitTest, 'unit-two\n');
  const afterRunnerTestChange = resolveExpectedRunnerCacheMetadata(
    IOS_SIMULATOR,
    root,
  ).runnerSourceFingerprint;
  assert.notEqual(afterRunnerTestChange, afterIgnoredChanges);
});
