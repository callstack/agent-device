// The TypeScript project graph is three hand-written views of one fact: the workspace package
// set, the root manifest's `workspace:*` declarations, and the `references` lists in the root,
// examples/sdk, and per-package tsconfigs. `tsc -b` fails loudly on a MISSING reference it
// needs but silently tolerates EXTRA ones (#3289 review), so a package added to the workspace
// while a references list goes un-updated keeps building a stale graph that still exits 0.
// These tests read the committed declarations against each other so the four views cannot
// drift: an added, renamed, or removed workspace package must edit every list or fail here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readWorkspacePackages } from './package-boundaries.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/** tsconfig JSONC minus line comments; both comment-bearing files use `//` only. */
function readTsconfig(relativePath: string): { references?: { path: string }[] } {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  return JSON.parse(source.replaceAll(/^\s*\/\/.*$/gm, ''));
}

/** Repo-relative package dir for one `references[].path` entry, resolved from its project. */
function referencedPackageDirs(tsconfigFile: string, projectDir: string): string[] {
  const config = readTsconfig(tsconfigFile);
  return (config.references ?? [])
    .map((reference) => path.posix.normalize(path.posix.join(projectDir, reference.path)))
    .sort();
}

function workspacePackageDirs(): string[] {
  return readWorkspacePackages(repoRoot)
    .map((pkg) => pkg.dir)
    .sort();
}

test('root and examples/sdk reference exactly the workspace package set', () => {
  const expected = workspacePackageDirs();
  assert.ok(expected.length >= 25, 'expected the 25+ workspace packages to be enumerable');

  assert.deepEqual(referencedPackageDirs('tsconfig.json', '.'), expected);
  assert.deepEqual(referencedPackageDirs('examples/sdk/tsconfig.json', 'examples/sdk'), expected);
});

test('the root manifest declares every workspace package as a workspace dependency', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })
    .filter(([, range]) => String(range).startsWith('workspace:'))
    .map(([name]) => name)
    .sort();
  const expected = readWorkspacePackages(repoRoot)
    .map((pkg) => pkg.name)
    .sort();
  assert.deepEqual(
    declared,
    expected,
    'a workspace package the root program consumes must be declared workspace:* in the root ' +
      'manifest (its tsconfig references already name it; the root project resolves package ' +
      'specifiers through these declarations)',
  );
});

test('the freerange config stays a reference-free view of the root program', () => {
  // `fr` loads every `references` project as a full simultaneous ts.Program (~26 programs,
  // >2.8 GB heap before analysis) and OOMs Node's default 4 GB on this workspace (#3289 CI).
  // The wrapper at scripts/freerange/tsconfig.json exists only because `extends` does not
  // inherit references (planted with --showConfig); if someone adds references to it, the
  // gate reintroduces the OOM, so the absence is pinned here rather than trusted to the comment.
  const config = readTsconfig('scripts/freerange/tsconfig.json');
  assert.equal(config.references, undefined, 'references on the freerange config OOM gate');
  assert.equal(
    config.extends,
    '../../tsconfig.json',
    'the freerange view must stay the root program itself (no include/exclude drift)',
  );
});

test('every package tsconfig references exactly its manifest workspace dependencies', () => {
  // The per-package half of the same single-source-of-truth claim (#3279 requirement 1):
  // references are DERIVED from the manifest DAG, so an import a manifest gains must add the
  // matching reference (edge freshness, which tsc -b never asks for) and a removed one must
  // drop it (an extra reference hides a stale edge that tsc -b tolerates silently).
  const packages = readWorkspacePackages(repoRoot);
  const nameByDir = new Map(packages.map((pkg) => [pkg.dir, pkg.name]));
  for (const pkg of packages) {
    const referencedDirs = referencedPackageDirs(`${pkg.dir}/tsconfig.json`, pkg.dir);
    for (const dir of referencedDirs) {
      assert.ok(
        nameByDir.has(dir),
        `${pkg.dir}/tsconfig.json references ${dir}, which is not a workspace package`,
      );
    }
    assert.deepEqual(
      referencedDirs.map((dir) => nameByDir.get(dir)),
      [...pkg.workspaceDependencies].sort(),
      `${pkg.dir}/tsconfig.json references must equal its manifest workspace:* dependencies`,
    );
  }
});
