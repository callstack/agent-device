import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';
import { workspaceSourceAliases } from './workspace-aliases.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('Stryker aliases every exported workspace subpath exactly', () => {
  const targets = workspaceSpecifierTargets(repoRoot);
  const aliases = workspaceSourceAliases(repoRoot, 'tracked-manifests');

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

test('disk manifests alias an untracked sandbox copy the tracked reader cannot see', () => {
  fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
  const sandboxRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'stryker-sandbox-fixture-'));
  try {
    const packageDir = path.join(sandboxRoot, 'packages', 'kernel');
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@agent-device/kernel',
        exports: { './errors': { default: './src/errors.ts' } },
      }),
    );
    fs.writeFileSync(path.join(packageDir, 'src', 'errors.ts'), 'export const mutated = true;\n');

    assert.deepEqual(
      workspaceSourceAliases(sandboxRoot, 'tracked-manifests'),
      [],
      'the git-backed reader must see nothing in an untracked copy',
    );

    const diskAliases = workspaceSourceAliases(sandboxRoot, 'disk-manifests');
    const match = diskAliases.filter(({ find }) => find.test('@agent-device/kernel/errors'));
    assert.deepEqual(
      match.map(({ replacement }) => replacement),
      [path.join(sandboxRoot, 'packages', 'kernel', 'src', 'errors.ts')],
      'the disk reader must resolve the specifier inside the sandbox copy',
    );
    assert.equal(
      diskAliases.some(({ find }) => find.test('@agent-device/kernel/not-exported')),
      false,
    );
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
