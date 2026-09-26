import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'vitest';
import {
  evaluateExistingXctestrun,
  resolveRunnerCacheMetadataPath,
  writeRunnerCacheMetadata,
  writeRunnerCacheMetadataForArtifacts,
} from '../runner-cache.ts';
import { resolveExpectedRunnerCacheMetadata } from '../runner-cache-metadata.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  EXECUTABLE_BYTES,
  digest,
  makeCachedRunnerBuild,
  mismatchOf,
  publishedXctestrun,
} from './runner-cache.fixtures.ts';

stubAppleToolchainProbes();

test('a manifest-certified build is reused', async () => {
  const { derived, xctestrunPath, executablePath, expected } = await makeCachedRunnerBuild();

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'reuse_ready');
  assert.equal(state.reason === 'reuse_ready' ? state.xctestrunPath : null, xctestrunPath);
  assert.deepEqual(state.reason === 'reuse_ready' ? state.productPaths : null, [
    path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'Runner-Runner.app'),
  ]);
  assert.ok(fs.existsSync(executablePath));
});

test('executable bytes rewritten with equal size and preserved stats break reuse', async () => {
  const { derived, executablePath, expected } = await makeCachedRunnerBuild();
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
  const { derived, executablePath, expected } = await makeCachedRunnerBuild();

  fs.appendFileSync(executablePath, 'x');

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'size_changed');
});

test('a lost permission bit breaks reuse', async () => {
  const { derived, executablePath, expected } = await makeCachedRunnerBuild();

  fs.chmodSync(executablePath, 0o644);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'mode_changed');
});

test('a missing executable breaks reuse', async () => {
  const { derived, executablePath, expected } = await makeCachedRunnerBuild();

  fs.rmSync(executablePath);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'missing');
});

test('a certified executable replaced by a directory breaks reuse', async () => {
  const { derived, executablePath, expected } = await makeCachedRunnerBuild();

  fs.rmSync(executablePath);
  fs.mkdirSync(executablePath);

  // The manifest names a file at that path; the tree now holds no file there at all.
  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'missing');
});

test('a file added under a certified product breaks reuse', async () => {
  const { derived, runnerAppPath, expected } = await makeCachedRunnerBuild();

  fs.writeFileSync(path.join(runnerAppPath, 'injected.dylib'), 'injected');

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'undeclared_entry');
});

test('a certified symlink that starts escaping the cache root breaks reuse', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, runnerAppPath, expected } = await makeCachedRunnerBuild();
  const linkPath = path.join(runnerAppPath, 'Frameworks');
  fs.mkdirSync(path.join(runnerAppPath, 'FrameworksInside'), { recursive: true });
  fs.symlinkSync('FrameworksInside', linkPath);
  await writeRunnerCacheMetadataForArtifacts(derived, expected, publishedXctestrun(derived), [
    runnerAppPath,
  ]);

  fs.rmSync(linkPath);
  fs.symlinkSync(path.join(outside, 'evil'), linkPath);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'symlink_escapes_cache');
  assert.equal(state.mismatch.target, path.join(outside, 'evil'));
});

test('a symlink that changes target but stays inside the cache is a target change', async () => {
  const { derived, runnerAppPath, expected } = await makeCachedRunnerBuild();
  const linkPath = path.join(runnerAppPath, 'Frameworks');
  fs.mkdirSync(path.join(runnerAppPath, 'FrameworksInside'), { recursive: true });
  fs.mkdirSync(path.join(runnerAppPath, 'FrameworksMoved'), { recursive: true });
  fs.symlinkSync('FrameworksInside', linkPath);
  await writeRunnerCacheMetadataForArtifacts(derived, expected, publishedXctestrun(derived), [
    runnerAppPath,
  ]);

  fs.rmSync(linkPath);
  fs.symlinkSync('FrameworksMoved', linkPath);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  assert.equal(state.mismatch.reason, 'symlink_target_changed');
});

test('a product root that is a symlink out of the cache is never certified', async () => {
  const derived = mkdtempForTestSync('agent-device-runner-cache-symlink-root-');
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => {
    fs.rmSync(derived, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const realProduct = path.join(outside, 'Runner-Runner.app');
  fs.mkdirSync(realProduct, { recursive: true });
  fs.writeFileSync(path.join(realProduct, 'Runner'), EXECUTABLE_BYTES, { mode: 0o755 });
  const productsPath = path.join(derived, 'Build', 'Products');
  const linkedProduct = path.join(productsPath, 'Debug-iphonesimulator', 'Runner-Runner.app');
  fs.mkdirSync(path.dirname(linkedProduct), { recursive: true });
  fs.symlinkSync(realProduct, linkedProduct);
  const xctestrunPath = path.join(productsPath, 'Runner_iphonesimulator26.2-arm64.xctestrun');
  fs.writeFileSync(xctestrunPath, '<plist>xctestrun</plist>');
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  await writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [linkedProduct]);

  const published = JSON.parse(
    fs.readFileSync(resolveRunnerCacheMetadataPath(derived), 'utf8'),
  ) as { artifacts?: unknown };
  assert.equal(published.artifacts, undefined);
});

test('a symlinked product root that stays inside the cache is certified', async () => {
  const derived = mkdtempForTestSync('agent-device-runner-cache-symlink-inside-');
  onTestFinished(() => fs.rmSync(derived, { recursive: true, force: true }));
  const productsPath = path.join(derived, 'Build', 'Products');
  const stagedProduct = path.join(derived, 'staged', 'Runner-Runner.app');
  fs.mkdirSync(stagedProduct, { recursive: true });
  fs.writeFileSync(path.join(stagedProduct, 'Runner'), EXECUTABLE_BYTES, { mode: 0o755 });
  const linkedProduct = path.join(productsPath, 'Debug-iphonesimulator', 'Runner-Runner.app');
  fs.mkdirSync(path.dirname(linkedProduct), { recursive: true });
  fs.symlinkSync(path.join(derived, 'staged', 'Runner-Runner.app'), linkedProduct);
  const xctestrunPath = path.join(productsPath, 'Runner_iphonesimulator26.2-arm64.xctestrun');
  fs.writeFileSync(xctestrunPath, '<plist>xctestrun</plist>');
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  await writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [linkedProduct]);

  // Names describe where the bytes actually live, not the link that reached them, so re-pointing
  // the in-cache symlink at another bundle cannot make reuse read an uncertified tree.
  const published = JSON.parse(
    fs.readFileSync(resolveRunnerCacheMetadataPath(derived), 'utf8'),
  ) as { artifacts?: { entries: Array<{ path: string }> } };
  assert.deepEqual(
    published.artifacts?.entries.map((entry) => entry.path),
    [path.join('staged', 'Runner-Runner.app', 'Runner')],
  );

  fs.rmSync(linkedProduct);
  const swapped = path.join(derived, 'staged', 'Other.app');
  fs.mkdirSync(swapped, { recursive: true });
  fs.writeFileSync(path.join(swapped, 'Runner'), Buffer.alloc(4096, 9), { mode: 0o755 });
  fs.symlinkSync(swapped, linkedProduct);

  const state = mismatchOf(
    await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected }),
  );

  // The walk follows the re-pointed root, and the bundle it now reaches was never certified.
  assert.equal(state.mismatch.reason, 'undeclared_entry');
});

test('a manifest that certifies an escaping symlink refuses reuse', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, runnerAppPath, expected } = await makeCachedRunnerBuild();
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

  assert.equal(state.mismatch.reason, 'symlink_escapes_cache');
});

test('a build holding an escaping symlink publishes no manifest at all', async () => {
  const { derived, runnerAppPath, xctestrunPath, expected } = await makeCachedRunnerBuild();
  fs.symlinkSync('../../../../../outside', path.join(runnerAppPath, 'Frameworks'));

  await writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [runnerAppPath]);

  const published = JSON.parse(
    fs.readFileSync(resolveRunnerCacheMetadataPath(derived), 'utf8'),
  ) as { artifacts?: unknown };
  assert.equal(published.artifacts, undefined);
});

test('an unreadable product subtree is refused and reported, not silently uncertified', async () => {
  const { derived, runnerAppPath, expected, xctestrunPath } = await makeCachedRunnerBuild();
  const sealed = path.join(runnerAppPath, 'Sealed.framework');
  fs.mkdirSync(sealed, { recursive: true });
  fs.writeFileSync(path.join(sealed, 'Binary'), 'binary');
  fs.chmodSync(sealed, 0o000);
  onTestFinished(() => {
    fs.chmodSync(sealed, 0o755);
  });

  const refusal = await writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [
    runnerAppPath,
  ]);

  assert.deepEqual(refusal, {
    reason: 'root_unusable',
    path: path.relative(derived, sealed),
  });
  const published = JSON.parse(
    fs.readFileSync(resolveRunnerCacheMetadataPath(derived), 'utf8'),
  ) as { artifacts?: unknown };
  assert.equal(published.artifacts, undefined);
});

test('a manifest whose .xctestrun was replaced by a symlink refuses reuse', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, expected, runnerAppPath } = await makeCachedRunnerBuild();
  const realXctestrun = path.join(outside, 'real.xctestrun');
  fs.writeFileSync(realXctestrun, fs.readFileSync(publishedXctestrun(derived)));
  const linkedXctestrun = path.join(derived, 'Build', 'Products', 'linked.xctestrun');
  fs.rmSync(publishedXctestrun(derived));
  fs.symlinkSync(realXctestrun, linkedXctestrun);

  writeRunnerCacheMetadata(derived, {
    ...expected,
    artifacts: {
      xctestrunPath: linkedXctestrun,
      xctestrunSize: fs.statSync(realXctestrun).size,
      xctestrunDigest: digest(realXctestrun),
      productPaths: [runnerAppPath],
      entries: [
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

  // The manifest names a regular file; a symlink is not one, so its bytes are never digested
  // from wherever the link happens to point.
  assert.equal(state.mismatch.reason, 'kind_changed');
  assert.equal(state.mismatch.path, linkedXctestrun);
});

test('a build whose .xctestrun is a symlink out of the cache publishes no manifest', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, runnerAppPath, expected } = await makeCachedRunnerBuild();
  const staged = path.join(outside, 'real.xctestrun');
  fs.writeFileSync(staged, '<plist>xctestrun</plist>');
  const linkedXctestrun = path.join(derived, 'Build', 'Products', 'linked.xctestrun');
  fs.rmSync(publishedXctestrun(derived));
  fs.symlinkSync(staged, linkedXctestrun);

  const refusal = await writeRunnerCacheMetadataForArtifacts(derived, expected, linkedXctestrun, [
    runnerAppPath,
  ]);

  assert.equal(refusal?.reason, 'root_escapes_cache');
  const published = JSON.parse(
    fs.readFileSync(resolveRunnerCacheMetadataPath(derived), 'utf8'),
  ) as { artifacts?: unknown };
  assert.equal(published.artifacts, undefined);
});

test('products without a content manifest are a miss, never a reuse', async () => {
  const { derived, expected } = await makeCachedRunnerBuild();

  writeRunnerCacheMetadata(derived, expected);

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'artifact_manifest_missing');
});

test('a manifest naming paths outside the cache root is a miss', async () => {
  const outside = mkdtempForTestSync('agent-device-runner-cache-outside-');
  onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
  const { derived, expected } = await makeCachedRunnerBuild();
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
  const { derived, expected } = await makeCachedRunnerBuild();
  await writeRunnerCacheMetadataForArtifacts(
    derived,
    expected,
    path.join(derived, 'Build', 'Products', 'other.xctestrun'),
    [path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'Runner-Runner.app')],
  );

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'artifact_manifest_missing');
});

test('a cache root reached through a symlinked ancestor is certified and reused', async () => {
  // macOS reports TMPDIR under /var, which is a symlink to /private/var. A cache whose root is
  // named through such a link must still certify, or every daemon on such a host rebuilds.
  const root = mkdtempForTestSync('agent-device-runner-cache-ancestor-link-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const realRoot = path.join(root, 'real');
  const linkedRoot = path.join(root, 'link');
  fs.mkdirSync(realRoot, { recursive: true });
  fs.symlinkSync(realRoot, linkedRoot);
  const derived = path.join(linkedRoot, 'derived');
  const productsPath = path.join(derived, 'Build', 'Products');
  const runnerAppPath = path.join(productsPath, 'Debug-iphonesimulator', 'Runner-Runner.app');
  fs.mkdirSync(runnerAppPath, { recursive: true });
  fs.writeFileSync(path.join(runnerAppPath, 'Runner'), EXECUTABLE_BYTES, { mode: 0o755 });
  const xctestrunPath = path.join(productsPath, 'Runner_iphonesimulator26.2-arm64.xctestrun');
  fs.writeFileSync(xctestrunPath, '<plist>xctestrun</plist>');
  const expected = resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR);

  assert.equal(
    await writeRunnerCacheMetadataForArtifacts(derived, expected, xctestrunPath, [runnerAppPath]),
    null,
  );

  const state = await evaluateExistingXctestrun({ derived, expectedCacheMetadata: expected });

  assert.equal(state.reason, 'reuse_ready');
});
