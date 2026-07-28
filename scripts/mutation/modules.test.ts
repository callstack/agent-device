import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  affectedModules,
  ALL_MODULE_IDS,
  KERNEL_MODULES,
  moduleForFile,
  mutateGlobs,
  shardMatrix,
} from './modules.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('every enumerated kernel path exists', () => {
  for (const module of KERNEL_MODULES) {
    for (const owned of module.owns) {
      assert.ok(
        fs.existsSync(path.join(repoRoot, owned)),
        `${module.id} owns a path that no longer exists: ${owned}`,
      );
    }
  }
});

test('changed sources map onto the module that owns them', () => {
  assert.equal(moduleForFile('src/kernel/errors.ts'), 'kernel-errors');
  assert.equal(moduleForFile('./src/daemon/ref-frame.ts'), 'daemon-ref-frame');
  assert.equal(moduleForFile('src/selectors/parse.ts'), 'selectors');
  // Selector tests live under the owned prefix; every other kernel's tests are
  // attributed by ownership.ts, not by this path match.
  assert.equal(moduleForFile('src/selectors/__tests__/resolve.test.ts'), 'selectors');
  assert.equal(moduleForFile('src/kernel/rect.ts'), undefined);
  assert.equal(moduleForFile('README.md'), undefined);
});

test('affected selection is deduplicated and registry-ordered', () => {
  assert.deepEqual(
    affectedModules([
      'src/selectors/parse.ts',
      'src/selectors/match.ts',
      'src/kernel/errors.ts',
      'docs/agents/testing.md',
    ]),
    ['kernel-errors', 'selectors'],
  );
  assert.deepEqual(affectedModules(['docs/agents/testing.md']), []);
});

test('mutate globs default to every module and narrow on request', () => {
  assert.deepEqual(mutateGlobs(), mutateGlobs(ALL_MODULE_IDS));
  assert.deepEqual(mutateGlobs(['kernel-errors']), ['src/kernel/errors.ts']);
});

// One job per module is only affordable while a module fits the lane's budget;
// the shard count is registry data so the workflows and the runner agree on it.
test('the shard matrix slices only the modules that declare shards', () => {
  assert.deepEqual(shardMatrix(['kernel-errors']), [
    { name: 'kernel-errors', module: 'kernel-errors' },
  ]);
  assert.deepEqual(shardMatrix(['selectors']), [
    { name: 'selectors-1', module: 'selectors', shard: '1/4' },
    { name: 'selectors-2', module: 'selectors', shard: '2/4' },
    { name: 'selectors-3', module: 'selectors', shard: '3/4' },
    { name: 'selectors-4', module: 'selectors', shard: '4/4' },
  ]);
  assert.equal(shardMatrix().length, ALL_MODULE_IDS.length + 3);
  // Every registry module reaches the matrix: an unsharded sweep is not a sweep.
  for (const id of ALL_MODULE_IDS) {
    assert.ok(
      shardMatrix().some((spec) => spec.module === id),
      `${id} has no shard`,
    );
  }
});
