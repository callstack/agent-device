import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { writeRunnerCacheMetadataForArtifacts } from '../runner-cache.ts';
import { resolveExpectedRunnerCacheMetadata } from '../runner-cache-metadata.ts';
import type { ExistingXctestrunState, RunnerXctestrunCacheMetadata } from '../runner-cache.ts';
import { stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// The identity half reads the host toolchain, so the fixture that builds a manifest answers those
// probes itself: a consumer must not have to know it is importing an Xcode-touching helper.
stubAppleToolchainProbes();

/**
 * A cache root and a content manifest for the tests that decide what a manifest certifies: the
 * bytes must exist before a digest can name them, and the layout must be the one a build leaves.
 */

export const EXECUTABLE_BYTES = Buffer.alloc(4096, 7);

export type CachedRunnerBuild = {
  derived: string;
  xctestrunPath: string;
  runnerAppPath: string;
  executablePath: string;
  expected: RunnerXctestrunCacheMetadata;
};

/**
 * A cache root laid out the way a build leaves it: the `.xctestrun` under Build/Products, a
 * product bundle with an executable, and a manifest certifying both.
 */
export async function makeCachedRunnerBuild(): Promise<CachedRunnerBuild> {
  const derived = mkdtempForTestSync('agent-device-runner-cache-eval-');
  onTestFinished(() => fs.rmSync(derived, { recursive: true, force: true }));
  const productsPath = path.join(derived, 'Build', 'Products');
  const runnerAppPath = path.join(productsPath, 'Debug-iphonesimulator', 'Runner-Runner.app');
  fs.mkdirSync(runnerAppPath, { recursive: true });
  const xctestrunPath = publishedXctestrun(derived);
  fs.writeFileSync(xctestrunPath, '<plist>xctestrun</plist>');
  const executablePath = path.join(runnerAppPath, 'Runner');
  fs.writeFileSync(executablePath, EXECUTABLE_BYTES, { mode: 0o755 });
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  // A fixture tree that cannot be certified would leave every consumer facing an opaque
  // `artifact_manifest_missing` instead of the named refusal the writer reports.
  assert.equal(
    await writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [runnerAppPath]),
    null,
  );
  return { derived, xctestrunPath, runnerAppPath, executablePath, expected };
}

export function publishedXctestrun(derived: string): string {
  return path.join(derived, 'Build', 'Products', 'Runner_iphonesimulator26.2-arm64.xctestrun');
}

export function mismatchOf(
  state: ExistingXctestrunState,
): Extract<ExistingXctestrunState, { reason: 'artifact_content_mismatch' }> {
  assert.equal(state.reason, 'artifact_content_mismatch');
  return state;
}
