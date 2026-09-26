import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onTestFinished, test } from 'vitest';
import { evaluateExistingXctestrun, writeRunnerCacheMetadata } from '../runner-cache.ts';
import { resolveExpectedRunnerCacheMetadata } from '../runner-cache-metadata.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { restoreEnvVar } from './runner-xctestrun.fixtures.ts';
import { makeCachedRunnerBuild } from './runner-cache.fixtures.ts';

stubAppleToolchainProbes();
test('reuse ignores the non-comparable package version', async () => {
  const { derived, expected } = makeCachedRunnerBuild();

  const state = await evaluateExistingXctestrun({
    derived,
    expectedCacheMetadata: { ...expected, packageVersion: `${expected.packageVersion}-next` },
  });

  assert.equal(state.reason, 'reuse_ready');
});

test('a metadata mismatch names the differing keys with expected and actual', async () => {
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  const derived = mkdtempForTestSync('agent-device-runner-cache-eval-');
  onTestFinished(() => fs.rmSync(derived, { recursive: true, force: true }));
  writeRunnerCacheMetadata(derived, {
    ...expected,
    xcodeBuildVersion: '17A100',
    runnerSandboxBuildArgs: [...expected.runnerSandboxBuildArgs, 'EXTRA=1'],
  });

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'cache_metadata_mismatch');
  assert.deepEqual(state.reason === 'cache_metadata_mismatch' ? state.metadataDifferences : null, [
    {
      key: 'runnerSandboxBuildArgs',
      expected: JSON.stringify(expected.runnerSandboxBuildArgs),
      actual: JSON.stringify([...expected.runnerSandboxBuildArgs, 'EXTRA=1']),
    },
    { key: 'xcodeBuildVersion', expected: '"17C52"', actual: '"17A100"' },
  ]);
});

test('an architecture override changes the cache identity', () => {
  const previous = process.env.AGENT_DEVICE_XCUITEST_ARCHS;
  try {
    process.env.AGENT_DEVICE_XCUITEST_ARCHS = 'arm64';
    const pinned = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
    delete process.env.AGENT_DEVICE_XCUITEST_ARCHS;
    const unpinned = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

    assert.deepEqual(pinned.runnerArchBuildSettings, ['ARCHS=arm64']);
    assert.deepEqual(unpinned.runnerArchBuildSettings, []);
    assert.notDeepEqual(pinned, unpinned);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_DEVICE_XCUITEST_ARCHS;
    } else {
      process.env.AGENT_DEVICE_XCUITEST_ARCHS = previous;
    }
  }
});

test('every runner build compiles the isolation canary, in both test variants', () => {
  const resolveSwiftFlags = () =>
    resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR).runnerSandboxBuildArgs.find((arg) =>
      arg.startsWith('OTHER_SWIFT_FLAGS='),
    );
  const previous = process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS;
  try {
    delete process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS;
    assert.equal(
      resolveSwiftFlags(),
      'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY',
    );

    process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS = '1';
    // A build that skipped the canary would pass every other gate while the isolation scan
    // silently had no positive control, so the unit-test variant must carry it too.
    assert.equal(
      resolveSwiftFlags(),
      'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY -D AGENT_DEVICE_RUNNER_UNIT_TESTS',
    );
  } finally {
    restoreEnvVar('AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS', previous);
  }
});
