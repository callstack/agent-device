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

test('changed files map onto the module that owns them', () => {
  assert.equal(moduleForFile('src/kernel/errors.ts'), 'kernel-errors');
  assert.equal(moduleForFile('./src/daemon/ref-frame.ts'), 'daemon-ref-frame');
  assert.equal(moduleForFile('src/selectors/parse.ts'), 'selectors');
  // Tests of a kernel are owned too: a weakened test is exactly the change
  // whose mutation score must be re-measured.
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
