import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'vitest';
import {
  evaluateExistingXctestrun,
  resolveRunnerCacheMetadataPath,
  writeRunnerCacheMetadata,
  writeRunnerCacheMetadataForArtifacts,
  type ExistingXctestrunState,
  type RunnerXctestrunCacheMetadata,
} from '../runner-cache.ts';
import { resolveExpectedRunnerCacheMetadata } from '../runner-cache-metadata.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';

stubAppleToolchainProbes();

const EXECUTABLE_BYTES = Buffer.alloc(4096, 7);

type CachedRunnerBuild = {
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
function makeCachedRunnerBuild(): CachedRunnerBuild {
  const derived = mkdtempForTestSync('agent-device-runner-cache-eval-');
  onTestFinished(() => fs.rmSync(derived, { recursive: true, force: true }));
  const productsPath = path.join(derived, 'Build', 'Products');
  const runnerAppPath = path.join(productsPath, 'Debug-iphonesimulator', 'Runner-Runner.app');
  fs.mkdirSync(runnerAppPath, { recursive: true });
  const xctestrunPath = path.join(productsPath, 'Runner_iphonesimulator26.2-arm64.xctestrun');
  fs.writeFileSync(xctestrunPath, '<plist>xctestrun</plist>');
  const executablePath = path.join(runnerAppPath, 'Runner');
  fs.writeFileSync(executablePath, EXECUTABLE_BYTES, { mode: 0o755 });
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);
  writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [runnerAppPath]);
  return { derived, xctestrunPath, runnerAppPath, executablePath, expected };
}

function mismatchOf(
  state: ExistingXctestrunState,
): Extract<ExistingXctestrunState, { reason: 'artifact_content_mismatch' }> {
  assert.equal(state.reason, 'artifact_content_mismatch');
  return state;
}

test('a manifest-certified build is reused', async () => {
  const { derived, xctestrunPath, executablePath, expected } = makeCachedRunnerBuild();

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'reuse_ready');
  assert.equal(state.reason === 'reuse_ready' ? state.xctestrunPath : null, xctestrunPath);
  assert.deepEqual(state.reason === 'reuse_ready' ? state.productPaths : null, [
    path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'Runner-Runner.app'),
  ]);
  assert.ok(fs.existsSync(executablePath));
});

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

test('every runner build compiles the isolation canary', () => {
  const swiftFlags = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR).runnerSandboxBuildArgs.find(
    (arg) => arg.startsWith('OTHER_SWIFT_FLAGS='),
  );

  assert.equal(
    swiftFlags,
    'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY',
  );
});

test('executable bytes rewritten with equal size and preserved stats break reuse', async () => {
  const { derived, executablePath, expected } = makeCachedRunnerBuild();
  const stat = fs.statSync(executablePath);

  fs.writeFileSync(executablePath, Buffer.alloc(EXECUTABLE_BYTES.length, 9), { mode: 0o755 });
  fs.utimesSync(executablePath, stat.atime, stat.mtime);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.deepEqual(state.mismatch, {
    path: path.relative(derived, executablePath),
    reason: 'digest_mismatch',
  });
});

test('a size change breaks reuse', async () => {
  const { derived, executablePath, expected } = makeCachedRunnerBuild();

  fs.appendFileSync(executablePath, 'x');

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'size_changed');
});

test('a lost permission bit breaks reuse', async () => {
  const { derived, executablePath, expected } = makeCachedRunnerBuild();

  fs.chmodSync(executablePath, 0o644);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'mode_changed');
});

test('a missing executable breaks reuse', async () => {
  const { derived, executablePath, expected } = makeCachedRunnerBuild();

  fs.rmSync(executablePath);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'missing');
});

test('a certified executable replaced by a directory breaks reuse', async () => {
  const { derived, executablePath, expected } = makeCachedRunnerBuild();

  fs.rmSync(executablePath);
  fs.mkdirSync(executablePath);

  // The manifest names a file at that path; the tree now holds no file there at all.
  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'missing');
});

test('a file added under a certified product breaks reuse', async () => {
  const { derived, runnerAppPath, expected } = makeCachedRunnerBuild();

  fs.writeFileSync(path.join(runnerAppPath, 'injected.dylib'), 'injected');

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'undeclared_entry');
});

test('a certified symlink that starts escaping the cache root breaks reuse', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, runnerAppPath, expected } = makeCachedRunnerBuild();
  const linkPath = path.join(runnerAppPath, 'Frameworks');
  fs.mkdirSync(path.join(runnerAppPath, 'FrameworksInside'), { recursive: true });
  fs.symlinkSync('FrameworksInside', linkPath);
  writeRunnerCacheMetadataForArtifacts(derived, expected, publishedXctestrun(derived), [
    runnerAppPath,
  ]);

  fs.rmSync(linkPath);
  fs.symlinkSync(path.join(outside, 'evil'), linkPath);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'symlink_target_changed');
});

test('a manifest that certifies an escaping symlink refuses reuse', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, runnerAppPath, expected } = makeCachedRunnerBuild();
  const escapingTarget = path.join(outside, 'Frameworks');
  fs.symlinkSync(escapingTarget, path.join(runnerAppPath, 'Frameworks'));
  writeRunnerCacheMetadata(derived, {
    ...expected,
    artifacts: {
      xctestrunPath: publishedXctestrun(derived),
      xctestrunSize: fs.statSync(publishedXctestrun(derived)).size,
      xctestrunDigest: digest(publishedXctestrun(derived)),
      productPaths: [runnerAppPath],
      entries: [
        {
          path: path
            .relative(derived, path.join(runnerAppPath, 'Frameworks'))
            .replaceAll(path.sep, '/'),
          symlink: escapingTarget,
        },
        {
          path: path
            .relative(derived, path.join(runnerAppPath, 'Runner'))
            .replaceAll(path.sep, '/'),
          size: EXECUTABLE_BYTES.length,
          mode: 0o755,
          digest: digest(path.join(runnerAppPath, 'Runner')),
        },
      ],
    },
  });

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'escaping_symlink');
});

test('a build holding an escaping symlink publishes no manifest at all', async () => {
  const { derived, runnerAppPath, xctestrunPath, expected } = makeCachedRunnerBuild();
  fs.symlinkSync('../../../../../outside', path.join(runnerAppPath, 'Frameworks'));

  writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [runnerAppPath]);

  const published = JSON.parse(
    fs.readFileSync(resolveRunnerCacheMetadataPath(derived), 'utf8'),
  ) as { artifacts?: unknown };
  assert.equal(published.artifacts, undefined);
});

test('products without a content manifest are a miss, never a reuse', async () => {
  const { derived, expected } = makeCachedRunnerBuild();

  writeRunnerCacheMetadata(derived, expected);

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'artifact_manifest_missing');
});

test('a manifest naming paths outside the cache root is a miss', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, expected } = makeCachedRunnerBuild();
  const foreignXctestrun = path.join(outside, 'foreign.xctestrun');
  fs.writeFileSync(foreignXctestrun, '<plist>xctestrun</plist>');
  writeRunnerCacheMetadata(derived, {
    ...expected,
    artifacts: {
      xctestrunPath: foreignXctestrun,
      xctestrunSize: 1,
      xctestrunDigest: '0'.repeat(64),
      productPaths: [path.join(outside, 'Runner-Runner.app')],
      entries: [{ path: 'Runner', size: 1, mode: 0o755, digest: '0'.repeat(64) }],
    },
  });

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'artifact_manifest_missing');
});

test('a manifest written for a foreign cache root certifies nothing', async () => {
  const { derived, expected } = makeCachedRunnerBuild();
  writeRunnerCacheMetadataForArtifacts(
    derived,
    expected,
    path.join(derived, 'Build', 'Products', 'other.xctestrun'),
    [path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'Runner-Runner.app')],
  );

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'artifact_manifest_missing');
});

function publishedXctestrun(derived: string): string {
  return path.join(derived, 'Build', 'Products', 'Runner_iphonesimulator26.2-arm64.xctestrun');
}

function digest(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
