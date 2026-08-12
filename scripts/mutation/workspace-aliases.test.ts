import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';
import { workspaceSourceAliases } from './workspace-aliases.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('Stryker aliases every exported workspace subpath exactly', () => {
  const targets = workspaceSpecifierTargets(repoRoot);
  const aliases = workspaceSourceAliases(repoRoot);

  for (const [specifier, target] of targets) {
    const matches = aliases.filter(({ find }) => find.test(specifier));
    assert.deepEqual(
      matches.map(({ replacement }) => replacement),
      [path.join(repoRoot, target)],
      `${specifier} must resolve to its own export instead of a package-root prefix`,
    );
  }

  assert.equal(
    aliases.some(({ find }) => find.test('@agent-device/selectors/not-exported')),
    false,
  );
});
