import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'vitest';
import {
  evaluateExistingXctestrun,
  writeRunnerCacheMetadata,
  type ExistingXctestrunState,
} from '../runner-cache.ts';
import { resolveExpectedRunnerCacheMetadata } from '../runner-cache-metadata.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';

stubAppleToolchainProbes();

function evaluateAgainstCachedMetadata(
  cached: Record<string, unknown>,
): Promise<ExistingXctestrunState> {
  const derived = mkdtempForTestSync('agent-device-runner-cache-eval-');
  onTestFinished(() => fs.rmSync(derived, { recursive: true, force: true }));
  const xctestrunPath = path.join(derived, 'Runner.xctestrun');
  fs.writeFileSync(xctestrunPath, 'xctestrun');
  writeRunnerCacheMetadata(derived, cached as never);
  return evaluateExistingXctestrun({
    derived,
    projectRoot: process.cwd(),
    expectedCacheMetadata: resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR),
    findXctestrun: () => xctestrunPath,
    xctestrunReferencesProjectRoot: () => true,
    resolveExistingXctestrunProductPaths: () => Promise.resolve([path.join(derived, 'Runner.app')]),
  });
}

test('a metadata mismatch names the differing keys with expected and actual', async () => {
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  const state = await evaluateAgainstCachedMetadata({
    ...expected,
    xcodeBuildVersion: '17A100',
    runnerSandboxBuildArgs: [...expected.runnerSandboxBuildArgs, 'EXTRA=1'],
  });

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

test('metadata that differs only in the non-comparable fields still reuses the cache', async () => {
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  const state = await evaluateAgainstCachedMetadata({
    ...expected,
    packageVersion: `${expected.packageVersion}-next`,
  });

  assert.equal(state.reason, 'reuse_ready');
});
