import path from 'node:path';
import { expect, test } from 'vitest';
import { KERNEL_MODULES, MAX_MUTATION_TEST_SCOPE_FILES } from '../mutation/modules.ts';
import { mutationTestScopes } from '../mutation/ownership.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('every kernel mutation scope fits one weekly shard', { timeout: 30_000 }, () => {
  const scopes = mutationTestScopes(repoRoot);
  const oversized = KERNEL_MODULES.map((module) => ({
    module: module.id,
    testFiles: scopes.get(module.id)?.length ?? 0,
  })).filter((scope) => scope.testFiles > MAX_MUTATION_TEST_SCOPE_FILES);
  expect(
    oversized,
    `A kernel's owned tests exceed MAX_MUTATION_TEST_SCOPE_FILES (${MAX_MUTATION_TEST_SCOPE_FILES}). ` +
      'Every shard replays the whole scope, so more shards do not help. Split the kernel in ' +
      'scripts/mutation/modules.ts, or import it from fewer tests.',
  ).toEqual([]);
});
