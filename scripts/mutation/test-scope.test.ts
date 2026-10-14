import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { test } from 'node:test';
import {
  expandMutateFiles,
  relatedTestFiles,
  readTestScope,
  TEST_SCOPE_ENV,
  threadHostileTestFiles,
} from './test-scope.ts';
import { mutateGlobs } from './modules.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('mutate globs expand to real kernel sources and exclude selector tests', () => {
  const files = expandMutateFiles(mutateGlobs(), repoRoot);
  assert.ok(files.includes('packages/kernel/src/errors.ts'));
  assert.ok(files.some((file) => file.startsWith('packages/selectors/src/')));
  assert.deepEqual(
    files.filter((file) => file.endsWith('.test.ts')),
    [],
  );
});

test('the thread-hostile exclusion is derived from imports, not listed', () => {
  const files = threadHostileTestFiles(repoRoot);
  // Both reasons are represented: process.chdir (CLI capture harness) and a
  // worker inside a worker (the node:worker_threads PNG pipeline).
  assert.ok(files.includes('src/__tests__/cli-help.test.ts'));
  assert.ok(files.includes('packages/capture-kit/src/png-worker.test.ts'));
  // A pure decision-kernel test is never excluded — that would hide survivors.
  assert.ok(!files.includes('packages/daemon/src/core/__tests__/ref-frame.test.ts'));
  assert.ok(files.every((file) => file.endsWith('.test.ts')));
});

test('related scope discovery follows indirect imports without executing tests', async () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-scope-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'scope-fixture', type: 'module' }),
    );
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'));
    const marker = path.join(root, 'executed');
    fs.writeFileSync(
      path.join(root, 'vitest.config.ts'),
      `export default { test: { projects: [{ test: { name: 'unit-core', include: ['src/**/*.test.ts'] } }] } };`,
    );
    fs.writeFileSync(path.join(root, 'src/kernel.ts'), 'export const value = 1;');
    fs.writeFileSync(path.join(root, 'src/consumer.ts'), "export { value } from './kernel';");
    fs.writeFileSync(
      path.join(root, 'src/consumer.test.ts'),
      `import { value } from './consumer'; import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(value)); throw new Error('discovery must not execute tests');`,
    );
    fs.writeFileSync(path.join(root, 'src/unrelated.test.ts'), "throw new Error('unrelated');");
    assert.deepEqual(await relatedTestFiles(['src/kernel.ts'], root, []), ['src/consumer.test.ts']);
    assert.equal(fs.existsSync(marker), false, 'scope discovery executed the test module');
    assert.deepEqual(await relatedTestFiles(['src/kernel.ts'], root, ['src/consumer.test.ts']), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing scope file is rejected and an empty scope file reads as an empty list', () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-empty-scope-'));
  const previous = process.env[TEST_SCOPE_ENV];
  try {
    const file = path.join(root, 'scope.json');
    process.env[TEST_SCOPE_ENV] = file;
    assert.throws(() => readTestScope(), /scope/i);
    fs.writeFileSync(file, '[]');
    assert.deepEqual(readTestScope(), []);
  } finally {
    if (previous === undefined) delete process.env[TEST_SCOPE_ENV];
    else process.env[TEST_SCOPE_ENV] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the selector mutation scope measures production decisions rather than test fixture builders', () => {
  const files = expandMutateFiles(mutateGlobs(['selectors']), repoRoot);
  assert.equal(
    files.some((file) => file.endsWith('.fixtures.ts')),
    false,
  );
  assert.ok(files.includes('packages/selectors/src/internal/parse.ts'));
});
