import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eagerClosureGraphOf } from '../../src/__tests__/eager-import-closure.fixtures.ts';
import {
  classifyBudget,
  describeClosurePressure,
  describePlatformOffenders,
  discoverFacadeEntryFiles,
  EAGER_CLOSURE_BUDGETS,
  FACADE_BUDGETS,
  HUB_BUDGETS,
  PLATFORM_IMPLEMENTATION_PATTERNS,
  type EagerClosureBudget,
} from './eager-closure-budgets.ts';

/**
 * The ADR-0019 loading-shape probe, generalized (#1739, #1960).
 *
 * ADR-0019 requires platform-package façades to stay implementation-lazy and is explicit that a
 * startup threshold alone is not a substitute for preserving the loading shape: "the tracking
 * issue owns the exact probe and planted-red procedure." #1950 built the walker this file reuses
 * (`src/__tests__/eager-import-closure.fixtures.ts`, AST-level: static value edges plus top-level
 * dynamic
 * imports, type-only erased) and proved the planted-red procedure on one file. This is that
 * probe, generalized to every workspace-package entry surface plus designated hub modules.
 *
 * - Catches: an entry surface or vocabulary module silently going eager -- the regression class
 *   #1950 fixed once and #1959/#1969 fixed at five more sites. Nothing else prevents the next
 *   instance: layering R13 governs import DIRECTION (may this file reach that one at all),
 *   never evaluation WEIGHT (how much of the repo an importer drags along).
 * - Evidence: planted red re-verified against this gate itself, not merely cited from #1950 --
 *   see the PR description. Every rule the real-tree assertions rest on (the equality ratchet,
 *   the bounded attribution, recursive discovery, row uniqueness) additionally has its own
 *   failing-direction test below, because a real tree that happens to satisfy its pins cannot
 *   distinguish a correct rule from a vacuous one.
 * - Cost: one unit-lane test file plus one data module; no subprocess, no device. The walker
 *   memoizes per-file edges, so the ~100 entries parse each reachable file once in total.
 * - Kill criterion: if two consecutive quarters show no pin ever tightening or firing, or
 *   ADR-0019 composition lands a stronger structural proof of the loading shape, delete this gate
 *   in favor of that proof.
 */

const repoRoot = path.resolve(import.meta.dirname, '../..');

// --- the rules, tested in their failing direction -------------------------------------------
// Each of these covers a hole that the real-tree assertions below cannot see: while the tree
// matches its pins, an `<=` comparison, a one-level discovery scan, and a duplicate-swallowing
// `Set` all look exactly like correct implementations.

test('the ratchet fails an entry that SHRANK, not only one that grew', () => {
  // The hole: `actual <= budget` passes every shrink, silently converting the gain into headroom
  // that a later regression grows back into unnoticed.
  expect(classifyBudget('x.ts', 42, 42)).toBeNull();
  expect(classifyBudget('x.ts', 43, 42)).toMatch(/evaluates 43 .*pinned at 42/);
  const shrank = classifyBudget('x.ts', 40, 42);
  expect(shrank).toMatch(/shrank/);
  expect(shrank, 'a shrink finding must tell the author the new number to pin').toMatch(
    /lower its pin to 40/,
  );
});

test('closure pressure is attributed to the heaviest direct edges and is bounded', () => {
  // The hole: printing a chain per evaluated module is unusable at src/cli.ts scale (363), so a
  // failure that "names the chain" can still be unreadable. This pins both halves: the offending
  // edge ranks first, and the output stays bounded however wide the entry is.
  const entry = '/repo/entry.ts';
  const graph = new Map<string, string | null>([[entry, null]]);
  // One heavy edge with a deep chain, one trivial edge, plus many shallow ones to force capping.
  graph.set('/repo/heavy.ts', entry);
  graph.set('/repo/heavy-2.ts', '/repo/heavy.ts');
  graph.set('/repo/heavy-3.ts', '/repo/heavy-2.ts');
  graph.set('/repo/light.ts', entry);
  for (let index = 0; index < 10; index += 1) graph.set(`/repo/filler-${index}.ts`, entry);

  const described = describeClosurePressure(graph, entry, '/repo');
  expect(described).toContain('heavy.ts -- 3 module(s) under this edge');
  expect(described.indexOf('heavy.ts')).toBeLessThan(described.indexOf('light.ts'));
  expect(described, 'the deep route must be shown, not just the edge name').toContain('heavy-3.ts');
  expect(described, 'output must be capped and say how much it omitted').toMatch(
    /\(\+\d+ more owning edge\(s\), \d+ module\(s\)\)/,
  );
  expect(described.split('\n').length).toBeLessThan(20);
});

test('a WIDE platform violation is capped, not dumped as hundreds of chains', () => {
  // The hole: the platform assertion printed every offender with its own full chain. One eagerly
  // imported platform subtree is hundreds of modules, which buries the single import that caused
  // them all. Fixture is deliberately wide -- 300 offenders under one owning edge, plus a second
  // owning edge and enough extra edges to force the "more owning edge(s)" tail.
  const entry = '/repo/packages/contracts/src/facades/platform.ts';
  const graph = new Map<string, string | null>([[entry, null]]);
  const owningEdge = '/repo/packages/platform-apple/src/index.ts';
  graph.set(owningEdge, entry);
  const offenders = [owningEdge];
  for (let index = 0; index < 300; index += 1) {
    const file = `/repo/packages/platform-apple/src/mechanics-${index}.ts`;
    // Broad and a few levels deep, the shape a real platform subtree actually has.
    const parent =
      index < 10 ? owningEdge : `/repo/packages/platform-apple/src/mechanics-${index % 10}.ts`;
    graph.set(file, parent);
    offenders.push(file);
  }
  for (let index = 0; index < 6; index += 1) {
    const file = `/repo/packages/platform-android/src/extra-${index}.ts`;
    graph.set(file, entry);
    offenders.push(file);
  }

  const described = describePlatformOffenders(graph, entry, '/repo', offenders);
  expect(described).toContain('packages/platform-apple/src/index.ts -- 301');
  expect(described, 'the cap must be visible as an explicit omitted count').toMatch(
    /\(\+299 more platform implementation module\(s\) under this edge\)/,
  );
  expect(described, 'extra owning edges must be summarised, not listed').toMatch(
    /\(\+3 more owning edge\(s\), 3 platform implementation module\(s\)\)/,
  );
  // The whole point: bounded. 300+ offenders must not become 300+ printed chains.
  expect(described.split('\n').length).toBeLessThan(30);
  expect(described).not.toContain('mechanics-150.ts');
});

test('an entry that evaluates only itself is described without pretending to an edge', () => {
  // The six platform façades are exactly this shape, so the message they would print matters.
  const graph = new Map<string, string | null>([['/repo/solo.ts', null]]);
  expect(describeClosurePressure(graph, '/repo/solo.ts', '/repo')).toContain('only itself');
});

/**
 * A committed fixture repository: one workspace package with a manifest export target, a
 * top-level façade, a nested façade, and a test source. Everything here is TRACKED, so anything a
 * caller writes afterwards is by definition uncommitted scratch.
 *
 * A real git repo rather than a bare tmpdir because tracked-vs-untracked only exists relative to
 * git, following `scripts/layering/platform-package-repository.test.ts`.
 */
function mkGitFixtureRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const pkgDir = path.join(repo, 'packages/demo');
  fs.mkdirSync(path.join(pkgDir, 'src/facades/nested'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@agent-device/demo', exports: { '.': './src/entry.ts' } }),
  );
  fs.writeFileSync(path.join(pkgDir, 'src/entry.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/top.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/nested/deep.ts'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/skip.test.ts'), 'export const d = 4;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.test', 'commit', '-qm', 'base'],
    { cwd: repo },
  );
  return repo;
}

test('discovery is recursive and reads TRACKED files only', () => {
  // Two holes in one fixture, because both are about discovery seeing the wrong set of files.
  //
  // Recursion: a one-level `readdir` of `src/facades` omits `src/facades/nested/x.ts`, which R11's
  // scan covers -- the two gates would disagree about what a façade is, and this one would be the
  // lenient half.
  //
  // Tracked-only: the first fix for the recursion hole replaced R11's `listSourceFiles()` with a
  // raw filesystem walk, which regressed R11 itself. A layering gate describes COMMITTED state, so
  // an uncommitted scratch file under a scanned path must stay invisible -- otherwise someone's
  // local experiment fails a gate that is supposed to describe the repository (#1965 review).
  //
  // Both only exist relative to git, so this builds a real repository rather than a bare tmpdir,
  // following `scripts/layering/platform-package-repository.test.ts`.
  const repo = mkGitFixtureRepo('eager-closure-discovery-');
  const pkgDir = path.join(repo, 'packages/demo');

  // Written AFTER the commit and never added: a contributor's local scratch façade.
  fs.writeFileSync(path.join(pkgDir, 'src/facades/scratch.ts'), 'export const e = 5;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/nested/scratch.ts'), 'export const f = 6;\n');

  const discovered = discoverFacadeEntryFiles(repo);
  expect(discovered).toContain('packages/demo/src/entry.ts'); // manifest-declared
  expect(discovered).toContain('packages/demo/src/facades/top.ts');
  expect(discovered, 'a nested façade must not hide from the gate').toContain(
    'packages/demo/src/facades/nested/deep.ts',
  );
  expect(discovered, 'test sources are not entry surfaces').not.toContain(
    'packages/demo/src/facades/skip.test.ts',
  );
  expect(discovered, 'an untracked scratch façade is not committed state').not.toContain(
    'packages/demo/src/facades/scratch.ts',
  );
  expect(discovered, 'nor is an untracked file beside a tracked nested façade').not.toContain(
    'packages/demo/src/facades/nested/scratch.ts',
  );
});

test('an untracked PACKAGE contributes no entry surface, however its manifest reads', () => {
  // Leak 1, and the reason the previous fixture was not enough: it only covered untracked files
  // under `src/facades/`. Manifest-derived targets bypassed that intersection entirely, because
  // `readWorkspacePackages` enumerated `packages/` with `readdirSync`. A package directory a
  // contributor has created but never committed would then contribute entry surfaces to R11 and
  // to the budget gate's exhaustiveness check — failing both on scratch work (#1965 review).
  const repo = mkGitFixtureRepo('eager-closure-untracked-package-');

  // Never added: a whole scratch package, manifest and source.
  const scratchPkg = path.join(repo, 'packages/scratch');
  fs.mkdirSync(path.join(scratchPkg, 'src/facades'), { recursive: true });
  fs.writeFileSync(
    path.join(scratchPkg, 'package.json'),
    JSON.stringify({ name: '@agent-device/scratch', exports: { '.': './src/index.ts' } }),
  );
  fs.writeFileSync(path.join(scratchPkg, 'src/index.ts'), 'export const z = 0;\n');
  fs.writeFileSync(path.join(scratchPkg, 'src/facades/thing.ts'), 'export const y = 0;\n');

  const discovered = discoverFacadeEntryFiles(repo);
  expect(discovered, 'the committed package is still found').toContain(
    'packages/demo/src/facades/nested/deep.ts',
  );
  expect(discovered, "an untracked package's manifest target is not committed state").not.toContain(
    'packages/scratch/src/index.ts',
  );
  expect(discovered, "nor is an untracked package's façade file").not.toContain(
    'packages/scratch/src/facades/thing.ts',
  );
});

test('a dirty manifest naming an UNTRACKED target contributes no entry surface', () => {
  // Leak 2: the manifest file itself is tracked, so restricting manifests to tracked ones does not
  // close this — the working-tree EDIT names a target that was never committed. `existsSync` used
  // to admit it. Manifest-derived targets are now intersected with the tracked production set too,
  // so every path the function returns is committed whatever its origin.
  const repo = mkGitFixtureRepo('eager-closure-dirty-manifest-');
  const pkgDir = path.join(repo, 'packages/demo');

  // Uncommitted edit to a TRACKED manifest, pointing at an uncommitted file that does exist.
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@agent-device/demo',
      exports: { '.': './src/entry.ts', './draft': './src/draft.ts' },
    }),
  );
  fs.writeFileSync(path.join(pkgDir, 'src/draft.ts'), 'export const w = 0;\n');

  const discovered = discoverFacadeEntryFiles(repo);
  expect(discovered, 'the committed export target is still found').toContain(
    'packages/demo/src/entry.ts',
  );
  expect(
    discovered,
    'a target named only by an uncommitted manifest edit is not committed state',
  ).not.toContain('packages/demo/src/draft.ts');
});

test('no entry path is budgeted twice, checked before any Set could absorb it', () => {
  // Uniqueness within each record is a TypeScript error (ts1117, duplicate object literal key),
  // so the only duplicate still expressible is one path appearing in both records. Asserted on
  // the ARRAY: converting to a Set first is what made the original "exactly one row" claim
  // unfalsifiable.
  const ids = EAGER_CLOSURE_BUDGETS.map((entry) => entry.entryFile);
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) duplicated.push(id);
    seen.add(id);
  }
  expect(
    duplicated,
    'These paths are budgeted twice (a path in both FACADE_BUDGETS and HUB_BUDGETS). One row per ' +
      'entry: pick the record that describes it.',
  ).toEqual([]);
  expect(ids.length).toBe(Object.keys(FACADE_BUDGETS).length + Object.keys(HUB_BUDGETS).length);
});

// --- the real tree --------------------------------------------------------------------------

test('every discovered entry surface has exactly one row, and none is stale', () => {
  // Bidirectional, mirroring the repo's other exhaustiveness gates (R7/R10 field checklists, the
  // R11 exhaustive re-export check): an entry surface with no row lets this whole mechanism go
  // silently vacuous for it -- which is exactly how the first version of this gate missed all six
  // platform-package façades -- and a row naming a file that is no longer an entry surface lets
  // the table drift from what it claims to police.
  const discovered = new Set(discoverFacadeEntryFiles(repoRoot));
  const budgeted = new Set(Object.keys(FACADE_BUDGETS));

  expect(
    [...discovered].filter((file) => !budgeted.has(file)).sort(),
    'These package entry surfaces (a package.json `exports` target, or a production file under a ' +
      '`src/facades/` directory) have no row in eager-closure-budgets.ts. Measure the current ' +
      'closure size and add one, or the loading-shape probe does not actually cover them.',
  ).toEqual([]);
  expect(
    [...budgeted].filter((file) => !discovered.has(file)).sort(),
    'These FACADE_BUDGETS rows are no longer a package entry surface. Remove the stale row or ' +
      'fix its path.',
  ).toEqual([]);
});

test('discovery reaches manifest-only façades with no facades/ directory', () => {
  // Non-vacuity with a specific target. The platform packages publish `./src/index.ts` and have no
  // `facades/` directory at all, so a directory-only scan omits precisely the files ADR-0019's
  // implementation-laziness rule is about while every assertion above stays green.
  const discovered = discoverFacadeEntryFiles(repoRoot);
  expect(discovered.length).toBeGreaterThan(50);
  for (const family of ['apple', 'android', 'harmonyos', 'vega', 'linux', 'web']) {
    expect(
      discovered,
      `packages/platform-${family} publishes its façade through the manifest, not a facades/ ` +
        'directory. If discovery stops finding it, the gate has lost the ADR-0019 subject.',
    ).toContain(`packages/platform-${family}/src/index.ts`);
  }
});

test('every budgeted entry file exists on disk', () => {
  const missing = EAGER_CLOSURE_BUDGETS.filter(
    (entry) => !fs.existsSync(path.resolve(repoRoot, entry.entryFile)),
  ).map((entry) => entry.entryFile);
  expect(missing, 'These eager-closure-budgets.ts rows name a file that does not exist.').toEqual(
    [],
  );
});

test.for(EAGER_CLOSURE_BUDGETS)('$id evaluates exactly $budget modules', (entry) => {
  const entryPath = path.resolve(repoRoot, entry.entryFile);
  const graph = eagerClosureGraphOf(entryPath);
  const finding = classifyBudget(entry.id, graph.size, entry.budget);
  expect(
    finding,
    finding === null
      ? ''
      : `${finding}\n\nWhere the weight comes from (heaviest direct edges, capped -- this ` +
          'attributes by shortest import route, it does not diff against a recorded baseline):\n' +
          describeClosurePressure(graph, entryPath, repoRoot),
  ).toBeNull();
});

test.for(EAGER_CLOSURE_BUDGETS.filter((entry) => entry.denyPlatformImplementations))(
  '$id never evaluates a concrete platform implementation',
  (entry: EagerClosureBudget) => {
    const entryPath = path.resolve(repoRoot, entry.entryFile);
    const graph = eagerClosureGraphOf(entryPath);
    // The entry itself is excluded: a platform package's own façade necessarily matches the
    // pattern, and the property worth asserting there is that it evaluates none of its OWN
    // mechanics either.
    const offenders = [...graph.keys()]
      .filter((file) => file !== entryPath)
      .filter((file) => PLATFORM_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(file)));
    expect(
      offenders.length,
      `${entry.id} evaluates ${offenders.length} concrete platform implementation module(s) ` +
        'before discovery or binding selects an owner (ADR-0019: the registry is metadata-eager ' +
        'and implementation-lazy). Move the owning edge behind a function-scoped `await import`.' +
        `\nWhere they come in (capped):\n${describePlatformOffenders(graph, entryPath, repoRoot, offenders)}`,
    ).toBe(0);
  },
);
