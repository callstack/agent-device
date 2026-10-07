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
function readTsconfig(relativePath: string): {
  references?: { path: string }[];
  extends?: string;
  include?: string[];
  exclude?: string[];
  compilerOptions?: Record<string, unknown>;
} {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  return JSON.parse(source.replaceAll(/^\s*\/\/.*$/gm, ''));
}

/**
 * The published root package name. It names no composite project: the root tsconfig is a
 * noEmit entry point TS6310 forbids referencing, so a workspace dependency on it is
 * type-resolved through tsconfig `paths`, never through a reference edge.
 */
const rootPackageName = (
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { name: string }
).name;

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

test('the compiled-set predicate is licensed by the tsconfig include/exclude shape it mirrors', () => {
  // `insideCompiledSources` (package-boundaries.ts) hard-codes the three include shapes the
  // tsc -b graph compiles: `packages/*/src`, root `src`, root `test`. That regex is honest
  // only while no project widens its file set behind it, so the shape is pinned here (the
  // file that already reads the tsconfigs), and the R11 side keeps its pin in
  // package-boundaries.test.ts (the #3279 walk-region test). A package tsconfig that gains
  // an `exclude`, or an include beyond `src` (plus replay-port's shared `global.d.ts`
  // sibling), or a root file added to the root include beyond src/test, must update the
  // predicate or fail here — the same "views cannot drift" rule as the reference lists.
  assert.deepEqual(readTsconfig('tsconfig.json').include, [
    'src',
    'test',
    'scripts/help-conformance-command-validator.ts',
    'packages/command-registry/src/global.d.ts',
  ]);
  // `src` everywhere, plus the one shared ambient-declaration entry replay-port and
  // session-journal include. Exact include ARRAYS, not a `global.d.ts` suffix class: a
  // new include of any name must extend this allow-list deliberately, or the drift fails
  // the test (#3289 cubic review P2 — a suffix filter would silently accept unrelated
  // `*.global.d.ts` additions, which is the drift this pin exists to catch).
  const knownIncludeShapes = [
    JSON.stringify(['src']),
    JSON.stringify(['src', '../command-registry/src/global.d.ts']),
  ];
  for (const pkg of readWorkspacePackages(repoRoot)) {
    const config = readTsconfig(`${pkg.dir}/tsconfig.json`);
    assert.equal(config.exclude, undefined, `${pkg.dir}/tsconfig.json must not declare exclude`);
    const include = JSON.stringify(config.include ?? ['**/*']);
    assert.ok(
      knownIncludeShapes.includes(include),
      `${pkg.dir}/tsconfig.json includes ${include}; the compiled-set predicate assumes ` +
        `the known shapes ${knownIncludeShapes.join(' / ')} — extend the allow-list here ` +
        'only after widening insideCompiledSources to match',
    );
  }
});

test('the one scripts file in the root program is the divergence insideCompiledSources records', () => {
  // The predicate classifies scripts/help-conformance-command-validator.ts as UNCOMPILED
  // (fail-closed: R11 keeps its full branch set there) even though the root include names
  // it. This is the assertion the predicate's doc block points at: the divergence is
  // recorded here, and a second scripts file joining the root program must be recorded
  // next to this one rather than silently widening the exception.
  const rootInclude = readTsconfig('tsconfig.json').include ?? [];
  const scriptsEntries = rootInclude.filter((entry) => entry.startsWith('scripts/'));
  assert.deepEqual(scriptsEntries, ['scripts/help-conformance-command-validator.ts']);
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
  // The one expressible-edge exception: a workspace dependency on the ROOT package
  // (`agent-device`) has no composite project to point at (TS6310). Those imports are
  // type-resolved through tsconfig `paths`, so the dependency is asserted present in
  // paths instead of references.
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
      [...pkg.workspaceDependencies].filter((name) => name !== rootPackageName).sort(),
      `${pkg.dir}/tsconfig.json references must equal its manifest workspace:* dependencies`,
    );
    if (pkg.workspaceDependencies.has(rootPackageName)) {
      const config = readTsconfig(`${pkg.dir}/tsconfig.json`);
      const paths = (config.compilerOptions?.paths ?? {}) as Record<string, unknown>;
      assert.ok(
        Object.keys(paths).some((key) => key.startsWith(`${rootPackageName}/`)),
        `${pkg.dir} depends on the root package without a paths mapping; tsc cannot ` +
          'resolve it (the root project cannot be referenced)',
      );
    }
  }
});
