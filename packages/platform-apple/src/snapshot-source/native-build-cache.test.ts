import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { createSnapshotSourceDeadline } from './deadline.ts';
import { createSnapshotSourceHost } from './host.ts';
import { ensureNativeBuildCacheEntry, fingerprintNativeBuildSource } from './native-build-cache.ts';
import type { SnapshotSourceHost } from './types.ts';

function testDeadline() {
  return createSnapshotSourceDeadline(30_000, undefined);
}

test('a cache hit skips the build, and a key-input or binary change rebuilds', async () => {
  const root = await mkdtempForTest('agent-device-native-build-cache-');
  const cacheRoot = path.join(root, 'cache');
  const host = createSnapshotSourceHost();
  let builds = 0;

  const ensure = (keyInputs: Readonly<Record<string, unknown>> = { sourceHash: 'abc' }) =>
    ensureNativeBuildCacheEntry({
      host,
      deadline: testDeadline(),
      cacheRoot,
      binaryFilename: 'built',
      lockDescription: 'test native build cache',
      keyInputs,
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

  const changedInputs = await ensure({ sourceHash: 'abc', compileArgv: ['-DNew'] });
  assert.notEqual(changedInputs.cacheKey, first.cacheKey);
  assert.equal(builds, 3, 'any key-input change, such as the compile argv, rebuilds');
  const manifest = JSON.parse(
    await readFile(path.join(path.dirname(changedInputs.path), 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(manifest.compileArgv, ['-DNew'], 'the manifest records the key inputs');
  assert.equal(manifest.cacheKey, changedInputs.cacheKey);
});

test('a failed build leaves no cache entry, and a later call can retry', async () => {
  const root = await mkdtempForTest('agent-device-native-build-cache-failure-');
  const cacheRoot = path.join(root, 'cache');
  const host = createSnapshotSourceHost();
  let attempts = 0;

  const ensure = () =>
    ensureNativeBuildCacheEntry({
      host,
      deadline: testDeadline(),
      cacheRoot,
      binaryFilename: 'built',
      lockDescription: 'test native build cache',
      keyInputs: { sourceHash: 'def' },
      build: async (outputPath) => {
        attempts += 1;
        if (attempts === 1) throw new Error('build failed');
        await writeFile(outputPath, 'binary-2');
      },
    });

  await assert.rejects(ensure(), /build failed/);
  assert.deepEqual(
    (await readdir(cacheRoot)).filter((name) => !name.endsWith('.lock')),
    [],
    'neither an entry nor a temp directory survives the failed build',
  );

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
