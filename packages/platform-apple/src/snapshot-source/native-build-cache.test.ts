import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { createSnapshotSourceDeadline } from './deadline.ts';
import { createSnapshotSourceHost } from './host.ts';
import {
  ensureNativeBuildCacheEntry,
  fingerprintNativeBuildSource,
  nativeBuildCacheKey,
  nativeBuildManifestFieldsMatch,
} from './native-build-cache.ts';
import type { SnapshotSourceHost } from './types.ts';

function testDeadline() {
  return createSnapshotSourceDeadline(30_000, undefined);
}

test('a cache hit skips the build, and a manifest or binary mismatch rebuilds', async () => {
  const root = await mkdtempForTest('agent-device-native-build-cache-');
  const cacheRoot = path.join(root, 'cache');
  const host = createSnapshotSourceHost();
  const manifest = { schemaVersion: 1, sourceHash: 'abc' };
  const cacheKey = nativeBuildCacheKey(manifest);
  let builds = 0;

  const ensure = () =>
    ensureNativeBuildCacheEntry({
      host,
      deadline: testDeadline(),
      cacheRoot,
      cacheKey,
      binaryFilename: 'built',
      lockDescription: 'test native build cache',
      manifest,
      manifestMatches: (candidate) =>
        nativeBuildManifestFieldsMatch(candidate, manifest, ['schemaVersion', 'sourceHash']),
      build: async (outputPath) => {
        builds += 1;
        await writeFile(outputPath, `binary-${builds}`);
      },
    });

  const first = await ensure();
  assert.equal(builds, 1);

  const hit = await ensure();
  assert.equal(hit.path, first.path);
  assert.equal(builds, 1, 'a matching cache entry is served without rebuilding');

  await writeFile(first.path, 'tampered');
  const afterTamper = await ensure();
  assert.equal(builds, 2, 'a binary hash mismatch rebuilds instead of serving a corrupt entry');
  assert.equal(await readFile(afterTamper.path, 'utf8'), 'binary-2');
});

test('manifest field matching compares by JSON value, not by reference or type coercion', () => {
  assert.equal(
    nativeBuildManifestFieldsMatch({ a: 1 }, { a: 1 }, ['a']),
    true,
    'equal primitives on the same field match',
  );
  assert.equal(
    nativeBuildManifestFieldsMatch({ a: '1' }, { a: 1 }, ['a']),
    false,
    'a string does not coerce to match a number',
  );
  assert.equal(
    nativeBuildManifestFieldsMatch({ a: { nested: 1 } }, { a: { nested: 1 } }, ['a']),
    true,
    'structurally equal objects on the same field match',
  );
  assert.equal(
    nativeBuildManifestFieldsMatch({}, { a: undefined }, ['a']),
    true,
    'a missing field matches an explicit undefined, since JSON.stringify drops both',
  );
  assert.equal(
    nativeBuildManifestFieldsMatch({ a: 1, b: 'x' }, { a: 1, b: 'y' }, ['a']),
    true,
    'only the named fields are compared',
  );
  assert.equal(
    nativeBuildManifestFieldsMatch({ a: 1, b: 'x' }, { a: 1, b: 'y' }, ['a', 'b']),
    false,
    'adding a field to the comparison set can turn a match into a mismatch',
  );
});

test('a failed build leaves no cache entry, and a later call can retry', async () => {
  const root = await mkdtempForTest('agent-device-native-build-cache-failure-');
  const cacheRoot = path.join(root, 'cache');
  const host = createSnapshotSourceHost();
  const manifest = { schemaVersion: 1, sourceHash: 'def' };
  const cacheKey = nativeBuildCacheKey(manifest);
  let attempts = 0;

  const ensure = () =>
    ensureNativeBuildCacheEntry({
      host,
      deadline: testDeadline(),
      cacheRoot,
      cacheKey,
      binaryFilename: 'built',
      lockDescription: 'test native build cache',
      manifest,
      manifestMatches: (candidate) =>
        nativeBuildManifestFieldsMatch(candidate, manifest, ['schemaVersion', 'sourceHash']),
      build: async (outputPath) => {
        attempts += 1;
        if (attempts === 1) throw new Error('build failed');
        await writeFile(outputPath, 'binary-2');
      },
    });

  await assert.rejects(ensure(), /build failed/);
  assert.equal(host.exists(path.join(cacheRoot, cacheKey)), false);

  const recovered = await ensure();
  assert.equal(attempts, 2);
  assert.equal(await readFile(recovered.path, 'utf8'), 'binary-2');
});

test('fingerprintNativeBuildSource keys on filename as well as content, so a rename busts the cache', async () => {
  const root = await mkdtempForTest('agent-device-native-fingerprint-');
  const host: SnapshotSourceHost = createSnapshotSourceHost();
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(root);
  await writeFile(path.join(root, 'A.m'), 'same content');
  await writeFile(path.join(root, 'B.m'), 'same content');

  const asA = await fingerprintNativeBuildSource(host, root, ['A.m'], testDeadline());
  const asB = await fingerprintNativeBuildSource(host, root, ['B.m'], testDeadline());
  assert.notEqual(asA, asB, 'identical bytes under a different filename fingerprint differently');

  const again = await fingerprintNativeBuildSource(host, root, ['A.m'], testDeadline());
  assert.equal(asA, again, 'fingerprinting is deterministic for the same root and filenames');
});
