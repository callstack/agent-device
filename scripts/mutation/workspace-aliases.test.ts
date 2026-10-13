import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveWorkspaceSpecifier } from '../layering/model.ts';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';
import { workspaceSourceAliases } from './workspace-aliases.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('Stryker aliases every exported workspace subpath exactly', () => {
  const targets = workspaceSpecifierTargets(repoRoot);
  const aliases = workspaceSourceAliases(repoRoot, 'tracked-manifests');

  for (const [specifier, target] of targets) {
    const matches = aliases.filter(({ find }) => find.test(specifier));
    if (!specifier.endsWith('*')) {
      assert.deepEqual(
        matches.map(({ replacement }) => replacement),
        [path.join(repoRoot, target)],
        `${specifier} must resolve to its own export instead of a package-root prefix`,
      );
      continue;
    }
    // A pattern entry aliases through a capture group filling its target's `*`,
    // so concrete imports resolve in the sandbox to the same module id as the
    // exports map gives them outside it (#3546 review).
    const pattern = matches.find(({ replacement }) => replacement.includes('$1'));
    assert.ok(pattern, `${specifier} must alias as a capture-group pattern`);
    const suffix = 'probe/nested';
    const applied = `${specifier.slice(0, -1)}${suffix}`.replace(pattern.find, pattern.replacement);
    const expected = path.join(repoRoot, target);
    const star = expected.indexOf('*');
    assert.equal(applied, expected.slice(0, star) + suffix + expected.slice(star + 1));
  }

  assert.equal(
    aliases.some(({ find }) => find.test('@agent-device/selectors/not-exported')),
    false,
  );
});

test('every exports map resolves through the alias table exactly as resolveWorkspaceSpecifier does', () => {
  // One semantics, three consumers: the alias table Vite applies first-match,
  // resolveWorkspaceSpecifier's longest-prefix rule, and Node's exports
  // resolution must pick the same module id for every concrete specifier.
  const targets = workspaceSpecifierTargets(repoRoot);
  const aliases = workspaceSourceAliases(repoRoot, 'tracked-manifests');
  for (const key of targets.keys()) {
    const probe = key.endsWith('*') ? `${key.slice(0, -1)}probe/nested` : key;
    const expected = resolveWorkspaceSpecifier(probe, targets);
    assert.ok(expected, `${probe} must resolve through the exports map`);
    const alias = aliases.find(({ find }) => find.test(probe));
    assert.ok(alias, `${probe} must hit an alias`);
    assert.equal(
      probe.replace(alias.find, alias.replacement),
      path.join(repoRoot, expected),
      `${probe} must hit the alias for its longest-prefix export`,
    );
  }
});

test('a named alias wins over a pattern alias that also matches it', () => {
  // Vite applies the first matching alias, so exact entries are ordered first;
  // a named `./testing/x` under a `./testing/*` pattern keeps its own export.
  const aliases = workspaceSourceAliases(repoRoot, 'tracked-manifests');
  const firstExact = aliases.findIndex(
    ({ find, replacement }) => !replacement.includes('$1') && find.source.includes('testing/'),
  );
  const lastPattern = aliases.findLastIndex(({ replacement }) => replacement.includes('$1'));
  assert.ok(
    firstExact === -1 || lastPattern === -1 || firstExact < lastPattern,
    'every exact alias must precede every pattern alias',
  );
});

test('overlapping patterns alias in longest-prefix order regardless of declaration order', () => {
  // The real manifests may happen to declare patterns in the order that hides a
  // missing sort, so plant the hostile order: `./testing/*` declared BEFORE
  // `./testing/handlers/*`. Vite applies the first matching alias, so the table
  // must still hand `testing/handlers/x` to the longer pattern — the same target
  // resolveWorkspaceSpecifier picks by Node's longest-prefix rule (#3546 review).
  fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
  const sandboxRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'stryker-overlap-fixture-'));
  try {
    const packageDir = path.join(sandboxRoot, 'packages', 'demo');
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@agent-device/demo',
        // The targets must differ per pattern or the suffix fill would land both
        // on the same file and the probe could not tell which alias fired.
        exports: {
          './testing/*': { default: './src/shadow/*.ts' },
          './testing/handlers/*': { default: './src/handlers/*.ts' },
        },
      }),
    );
    const diskAliases = workspaceSourceAliases(sandboxRoot, 'disk-manifests');
    const probe = '@agent-device/demo/testing/handlers/x';
    const alias = diskAliases.find(({ find }) => find.test(probe));
    assert.ok(alias, `${probe} must hit an alias`);
    assert.equal(
      probe.replace(alias.find, alias.replacement),
      path.join(sandboxRoot, 'packages', 'demo', 'src', 'handlers', 'x.ts'),
      `${probe} must alias through the longer pattern even though the shorter one was declared first`,
    );
    const targets = new Map([
      ['@agent-device/demo/testing/*', 'packages/demo/src/shadow/*.ts'],
      ['@agent-device/demo/testing/handlers/*', 'packages/demo/src/handlers/*.ts'],
    ]);
    assert.equal(
      probe.replace(alias.find, alias.replacement),
      path.join(sandboxRoot, resolveWorkspaceSpecifier(probe, targets)!),
      'the first-matched alias must agree with resolveWorkspaceSpecifier on hostile declaration order too',
    );
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('a repo root containing replacement patterns survives the alias round-trip', () => {
  // A checkout under a path like `/build/$1/app` is rare but legal. The pattern
  // alias applies with a STRING replacement, so every `$` in the repo path must
  // arrive doubled: with a plain `$$` string replace, `$$` means one `$` and
  // each `$` survives UNescaped, letting `$&`/`$1` in the path expand to the
  // match or the capture when Vite applies the alias (#3546 review).
  fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
  const sandboxRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'stryker-dollar-$&$1-fixture-'));
  try {
    const packageDir = path.join(sandboxRoot, 'packages', 'demo');
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@agent-device/demo',
        exports: { './testing/*': { default: './src/testing/*.ts' } },
      }),
    );
    const alias = workspaceSourceAliases(sandboxRoot, 'disk-manifests').find(({ find }) =>
      find.test('@agent-device/demo/testing/handlers/x'),
    );
    assert.ok(alias, 'the pattern export must produce an alias');
    assert.equal(
      '@agent-device/demo/testing/handlers/x'.replace(alias.find, alias.replacement),
      path.join(sandboxRoot, 'packages', 'demo', 'src', 'testing', 'handlers', 'x.ts'),
      'the $-bearing root must round-trip through the alias to its literal path',
    );
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
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
