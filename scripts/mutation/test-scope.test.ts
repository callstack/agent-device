import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { expandMutateFiles, threadHostileTestFiles } from './test-scope.ts';
import { mutateGlobs } from './modules.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('mutate globs expand to real kernel sources and exclude selector tests', () => {
  const files = expandMutateFiles(mutateGlobs(), repoRoot);
  assert.ok(files.includes('packages/kernel/src/errors.ts'));
  assert.ok(files.some((file) => file.startsWith('src/selectors/')));
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
  assert.ok(files.includes('src/utils/__tests__/png-worker.test.ts'));
  // A pure decision-kernel test is never excluded — that would hide survivors.
  assert.ok(!files.includes('src/daemon/__tests__/ref-frame.test.ts'));
  assert.ok(files.every((file) => file.endsWith('.test.ts')));
});
