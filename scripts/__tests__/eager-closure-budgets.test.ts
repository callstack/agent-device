import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eagerClosureGraphOf } from '../../src/__tests__/eager-import-closure.fixtures.ts';
import {
  createCommittedSourceTree,
  headCommit,
  mergeBaseWithMain,
  renamedSince,
} from './committed-source-tree.ts';
import {
  addedModules,
  APPROVED_OVER_CEILING,
  classifyGrowth,
  classifyNewEntry,
  describeClosureGrowth,
  describeClosurePressure,
  describePlatformOffenders,
  describeSharedGrowthHomes,
  discoverFacadeEntryFiles,
  eagerClosureEntries,
  entryCategoryOf,
  HUB_ENTRY_FILES,
  NEW_ENTRY_CEILINGS,
  PLATFORM_FACADE_CLOSURE,
  PLATFORM_IMPLEMENTATION_PATTERNS,
  staleApprovalRows,
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
 * probe, generalized to every workspace-package entry surface plus designated hub modules, and
 * ratcheted against the committed merge-base rather than against a table of numbers.
 *
 * - Catches: an entry surface or vocabulary module silently going eager -- the regression class
 *   #1950 fixed once and #1959/#1969 fixed at five more sites. Nothing else prevents the next
 *   instance: layering R13 governs import DIRECTION (may this file reach that one at all),
 *   never evaluation WEIGHT (how much of the repo an importer drags along).
 * - Evidence: planted red re-verified against this gate itself, not merely cited from #1950 --
 *   see the PR description. Every rule the real-tree assertions rest on (no growth, the
 *   ceilings, the committed-tree reader, rename following, the bounded attribution, recursive
 *   discovery) additionally has its own failing-direction test below, because a real tree that
 *   happens to satisfy its rules cannot distinguish a correct rule from a vacuous one.
 * - Cost: one unit-lane test file plus two data/reader modules; four git processes for the
 *   merge-base side (merge-base, ls-tree, one cat-file batch, one rename diff), no device. The
 *   walker memoizes per-file edges per tree and parses each file once per distinct content, so
 *   the base tree pays only for the files the branch changed.
 * - Kill criterion: if two consecutive quarters show no rule ever firing, or
 *   ADR-0019 composition lands a stronger structural proof of the loading shape, delete this gate
 *   in favor of that proof.
 */

const repoRoot = path.resolve(import.meta.dirname, '../..');
const absolute = (file: string) => path.resolve(repoRoot, file);

// --- the rules, tested in their failing direction -------------------------------------------
// Each of these covers a hole that the real-tree assertions below cannot see: while the tree
// satisfies its rules, a wrong comparison, an unfollowed rename, a reader that quietly falls
// back to the working directory, and a one-level discovery scan all look like correct rules.

test('no-growth fails growth with both counts and passes an equal or smaller closure', () => {
  expect(classifyGrowth('x.ts', 42, 42)).toBeNull();
  expect(classifyGrowth('x.ts', 42, 40)).toBeNull();
  expect(classifyGrowth('x.ts', 42, 43)).toMatch(/evaluates 43 modules.*merge-base evaluated 42/);
});

test('growth advice names both causes and both remedies, not one prescribed fix', () => {
  // #2423's review: a message that only ever says "move it behind a dynamic import" is wrong
  // advice when the growth is a new module that belongs in an existing one. This pins that the
  // verdict states both common causes and leaves the remedy to the reader.
  const finding = classifyGrowth('x.ts', 42, 43) ?? '';
  expect(finding).toMatch(/new static edge/);
  expect(finding).toMatch(/used to load on demand/);
  expect(finding).toMatch(/home in a module the closure already evaluates/);
  expect(finding).toMatch(/function-scoped `await import`/);
});

test('growth against the merge-base lists every added module, each with its shortest route, bounded', () => {
  // The hole: the old diagnostic named only the FIRST added module, which hid the pattern when a
  // whole PR's growth was really "everyone reached one new module" (#2423 review) rather than one
  // entry's own new edge. This pins that every added module is named (bounded), not just the
  // first, and that the route shown is the whole chain, not just the leaf.
  const entry = '/repo/entry.ts';
  const graph = new Map<string, string | null>([[entry, null]]);
  graph.set('/repo/old.ts', entry); // present at the merge-base too: not "added"
  graph.set('/repo/new-a.ts', entry);
  graph.set('/repo/new-b.ts', '/repo/new-a.ts');
  for (let index = 0; index < 12; index += 1) graph.set(`/repo/new-filler-${index}.ts`, entry);
  const base = new Set(['/repo/entry.ts', '/repo/old.ts']);

  const described = describeClosureGrowth(graph, base, entry, '/repo');
  expect(described, 'the route must show the whole chain, not just the leaf').toContain(
    'new-a.ts → new-b.ts',
  );
  expect(described, 'output must be capped and say how much it omitted').toMatch(
    /\(\+\d+ more newly evaluated module\(s\)\)/,
  );
  expect(described.split('\n').length).toBeLessThan(15);
});

test('a first-introduced entry fits its category ceiling or carries an approval', () => {
  expect(classifyNewEntry('x.ts', 'vocabulary-facade', 4, false)).toBeNull();
  expect(classifyNewEntry('x.ts', 'vocabulary-facade', 5, false)).toMatch(
    /new vocabulary-facade entry evaluating 5 modules.*ceiling of 4/,
  );
  expect(classifyNewEntry('x.ts', 'vocabulary-facade', 5, true)).toBeNull();
});

test('a stale approval is reported on a branch and deferred where no row is readable', () => {
  // The hole this closes: on a commit `main` already carries, the merge-base IS the head, so the
  // introduced set is empty and every row reads as stale however live it is. That is the shape of
  // the approving PR's own merge commit, which is why #2329 turned `main` red the moment it
  // landed. Both directions are pinned here: a row that has really died is still reported on the
  // branch that could have read it.
  const ceiling = NEW_ENTRY_CEILINGS['domain-facade'];
  const overCeiling = new Map([
    ['new.ts', { category: 'domain-facade' as const, closureSize: ceiling + 1 }],
  ]);
  const underCeiling = new Map([
    ['new.ts', { category: 'domain-facade' as const, closureSize: ceiling }],
  ]);
  expect(staleApprovalRows(['new.ts'], overCeiling, false), 'live: read by the ceiling').toEqual(
    [],
  );
  expect(staleApprovalRows(['new.ts'], underCeiling, false), 'stale: now fits').toEqual(['new.ts']);
  expect(staleApprovalRows(['gone.ts'], overCeiling, false), 'stale: not introduced').toEqual([
    'gone.ts',
  ]);
  expect(
    staleApprovalRows(['gone.ts'], new Map(), true),
    'the merge-base is the head: nothing is first-introduced, so no row can be judged',
  ).toEqual([]);
});

test('the category is derived from the path, never hand-listed', () => {
  expect(entryCategoryOf('packages/platform-vega/src/index.ts')).toBe('platform-facade');
  expect(entryCategoryOf('packages/contracts/src/facades/device.ts')).toBe('vocabulary-facade');
  expect(entryCategoryOf('packages/kernel/src/rect.ts')).toBe('domain-facade');
  expect(entryCategoryOf('src/cli.ts')).toBe('mechanics-surface');
  expect(() => entryCategoryOf('scripts/gate/check.ts')).toThrow(/neither/);
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

test('growth shared by two entries names the merge-base modules they already have in common', () => {
  // The aggregation #2423's review asked for: two entries independently grow by the SAME new
  // module. Per-entry diagnostics would each show that same chain with no hint that a shared
  // existing home was available -- this names the modules BOTH entries already evaluate, scoped
  // to the added module's own package, once.
  const addedFile = '/repo/packages/demo/src/new-thing.ts';
  const sharedHome = '/repo/packages/demo/src/shared-home.ts';
  const otherPkgFile = '/repo/packages/other/src/not-a-home.ts'; // different package: excluded
  const onlyInOne = '/repo/packages/demo/src/only-in-a.ts'; // not common to both: excluded

  const graphA = new Map<string, string | null>([
    ['/repo/entry-a.ts', null],
    [sharedHome, '/repo/entry-a.ts'],
    [onlyInOne, '/repo/entry-a.ts'],
    [otherPkgFile, '/repo/entry-a.ts'],
  ]);
  const graphB = new Map<string, string | null>([
    ['/repo/entry-b.ts', null],
    [sharedHome, '/repo/entry-b.ts'],
    [otherPkgFile, '/repo/entry-b.ts'],
  ]);

  const shared = describeSharedGrowthHomes(
    [
      { id: 'entry-a.ts', added: [addedFile], baseGraph: graphA, headClosureSize: graphA.size + 1 },
      { id: 'entry-b.ts', added: [addedFile], baseGraph: graphB, headClosureSize: graphB.size + 1 },
    ],
    '/repo',
  );

  expect(shared, 'labeled neutrally, not as a prescribed fix').toMatch(/possible homes/i);
  expect(shared).toContain('packages/demo/src/shared-home.ts');
  expect(shared, 'only in one entry: not a shared home').not.toContain('only-in-a.ts');
  expect(shared, 'a different package than the added module: not a candidate home').not.toContain(
    'not-a-home.ts',
  );
});

test('growth that no other entry shares produces no shared-homes note', () => {
  const graphA = new Map<string, string | null>([['/repo/entry-a.ts', null]]);
  expect(
    describeSharedGrowthHomes(
      [{ id: 'entry-a.ts', added: ['/repo/new.ts'], baseGraph: graphA, headClosureSize: 2 }],
      '/repo',
    ),
    'nothing to aggregate when only one entry grew by this module',
  ).toBeNull();
});

test('an equal-size replacement is not growth, so the aggregate stays silent', () => {
  // #2471's review: the aggregate used to take every entry with a newly evaluated module, which is
  // not the condition the per-entry rule applies. Both entries below swapped one module for
  // another -- same closure size, one module the merge-base did not evaluate, and the SAME one, so
  // the grouping would fire. `classifyGrowth` passes both, so this must print nothing at all.
  const addedFile = '/repo/packages/demo/src/new-thing.ts';
  const sharedHome = '/repo/packages/demo/src/shared-home.ts';
  const graphA = new Map<string, string | null>([
    ['/repo/entry-a.ts', null],
    [sharedHome, '/repo/entry-a.ts'],
    ['/repo/packages/demo/src/dropped-by-a.ts', '/repo/entry-a.ts'],
  ]);
  const graphB = new Map<string, string | null>([
    ['/repo/entry-b.ts', null],
    [sharedHome, '/repo/entry-b.ts'],
    ['/repo/packages/demo/src/dropped-by-b.ts', '/repo/entry-b.ts'],
  ]);

  expect(classifyGrowth('entry-a.ts', graphA.size, graphA.size)).toBeNull();
  expect(classifyGrowth('entry-b.ts', graphB.size, graphB.size)).toBeNull();
  expect(
    describeSharedGrowthHomes(
      [
        { id: 'entry-a.ts', added: [addedFile], baseGraph: graphA, headClosureSize: graphA.size },
        { id: 'entry-b.ts', added: [addedFile], baseGraph: graphB, headClosureSize: graphB.size },
      ],
      '/repo',
    ),
    'a swap at equal size is no violation: the aggregate may not fail where the rule passes',
  ).toBeNull();
  expect(
    describeSharedGrowthHomes(
      [
        { id: 'entry-a.ts', added: [addedFile], baseGraph: graphA, headClosureSize: graphA.size },
        {
          id: 'entry-b.ts',
          added: [addedFile],
          baseGraph: graphB,
          headClosureSize: graphB.size - 1,
        },
      ],
      '/repo',
    ),
    'a closure that shrank while adding a module is likewise not growth',
  ).toBeNull();
});

test('disjoint growth groups keep their own entries and homes in separate blocks', () => {
  // #2471's review: candidate homes from separate added-module groups were unioned into one list
  // labelled as common to every failing entry, which is false as soon as two groups exist. Both
  // added modules live in the same package here, so only the grouping -- not the package scope --
  // can keep them apart: new-x.ts grew a1/a2, new-y.ts grew b1/b2, and no closure is shared.
  const addedX = '/repo/packages/demo/src/new-x.ts';
  const addedY = '/repo/packages/demo/src/new-y.ts';
  const homeX = '/repo/packages/demo/src/home-x.ts';
  const homeY = '/repo/packages/demo/src/home-y.ts';
  const growth = (id: string, added: string, home: string) => {
    const entryPath = `/repo/${id}`;
    const baseGraph = new Map<string, string | null>([
      [entryPath, null],
      [home, entryPath],
    ]);
    return { id, added: [added], baseGraph, headClosureSize: baseGraph.size + 1 };
  };

  const shared = describeSharedGrowthHomes(
    [
      growth('entry-a1.ts', addedX, homeX),
      growth('entry-a2.ts', addedX, homeX),
      growth('entry-b1.ts', addedY, homeY),
      growth('entry-b2.ts', addedY, homeY),
    ],
    '/repo',
  );

  const blocks = (shared ?? '').split('\n\n');
  expect(blocks, 'one block per added module, never one merged list').toHaveLength(2);
  const blockX = blocks.find((block) => block.startsWith('packages/demo/src/new-x.ts')) ?? '';
  const blockY = blocks.find((block) => block.startsWith('packages/demo/src/new-y.ts')) ?? '';

  expect(blockX, 'each entry is named with how much it grew').toContain('entry-a1.ts (+1)');
  expect(blockX).toContain('entry-a2.ts (+1)');
  expect(blockX).toContain('packages/demo/src/home-x.ts');
  expect(blockX, 'b1/b2 did not grow by new-x.ts').not.toContain('entry-b1.ts');
  expect(blockX, 'no entry that grew by new-x.ts evaluates home-y.ts').not.toContain('home-y.ts');
  expect(blockY).toContain('entry-b1.ts (+1)');
  expect(blockY).toContain('packages/demo/src/home-y.ts');
  expect(blockY, 'a1/a2 did not grow by new-y.ts').not.toContain('entry-a1.ts');
  expect(blockY, 'no entry that grew by new-y.ts evaluates home-x.ts').not.toContain('home-x.ts');
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
    JSON.stringify({
      name: '@agent-device/demo',
      exports: { '.': './src/entry.ts' },
    }),
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

test('the committed-tree reader walks what was committed, not the working directory', () => {
  // The hole: a reader that falls back to `fs` for anything it cannot answer from git turns the
  // merge-base side into a second copy of the head side, and no-growth passes every growth.
  const repo = mkGitFixtureRepo('eager-closure-committed-tree-');
  const entry = path.join(repo, 'packages/demo/src/entry.ts');
  fs.writeFileSync(entry, "export * from './facades/top.ts';\n");
  fs.writeFileSync(path.join(repo, 'packages/demo/src/scratch.ts'), 'export const s = 1;\n');

  const committed = createCommittedSourceTree(repo, 'HEAD');
  expect(committed.isFile(path.join(repo, 'packages/demo/src/scratch.ts'))).toBe(false);
  expect(committed.readdir(path.join(repo, 'packages'))).toEqual(['demo']);
  expect(committed.readFile(entry)).toBe('export const a = 1;\n');
  expect(eagerClosureGraphOf(entry, committed).size, 'committed: no edges').toBe(1);
  expect(eagerClosureGraphOf(entry).size, 'working tree: one edge').toBe(2);
});

test('a renamed entry is followed to its path at the base, not treated as first-introduced', () => {
  const repo = mkGitFixtureRepo('eager-closure-renamed-entry-');
  execFileSync('git', ['mv', 'packages/demo/src/entry.ts', 'packages/demo/src/moved.ts'], {
    cwd: repo,
  });
  expect(renamedSince(repo, 'HEAD').get('packages/demo/src/moved.ts')).toBe(
    'packages/demo/src/entry.ts',
  );
});

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
    JSON.stringify({
      name: '@agent-device/scratch',
      exports: { '.': './src/index.ts' },
    }),
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

// --- the real tree --------------------------------------------------------------------------

const mergeBase = mergeBaseWithMain(repoRoot);
const baseTree = createCommittedSourceTree(repoRoot, mergeBase);
const renamedFrom = renamedSince(repoRoot, mergeBase);
const entries = eagerClosureEntries(repoRoot);

/** The entry's path in the merge-base tree (renames followed), or null when it was not there. */
function basePathOf(entryFile: string): string | null {
  const file = renamedFrom.get(entryFile) ?? entryFile;
  return baseTree.isFile(absolute(file)) ? file : null;
}

const baseGraphs = new Map<string, ReadonlyMap<string, string | null>>();
function baseGraphOf(baseFile: string): ReadonlyMap<string, string | null> {
  let graph = baseGraphs.get(baseFile);
  if (!graph) {
    graph = eagerClosureGraphOf(absolute(baseFile), baseTree);
    baseGraphs.set(baseFile, graph);
  }
  return graph;
}

const platformFacades = entries.filter((entry) => entry.category === 'platform-facade');
const others = entries.filter((entry) => entry.category !== 'platform-facade');
const carried = others.flatMap((entry) => {
  const baseFile = basePathOf(entry.entryFile);
  return baseFile === null ? [] : [{ ...entry, baseFile }];
});
const introduced = others.filter((entry) => basePathOf(entry.entryFile) === null);

/**
 * Every carried entry's growth data, computed once so the per-entry NO-GROWTH test below and the
 * cross-entry shared-homes note after it read the same graphs instead of walking each closure
 * twice.
 */
const carriedGrowth = carried.map((entry) => {
  const entryPath = absolute(entry.entryFile);
  const graph = eagerClosureGraphOf(entryPath);
  const baseGraph = baseGraphOf(entry.baseFile);
  const base = new Set(baseGraph.keys());
  return { entry, entryPath, graph, baseGraph, base, added: addedModules(graph, base, entryPath) };
});

test('every hub exists and is not also a discovered façade', () => {
  const discovered = new Set(discoverFacadeEntryFiles(repoRoot));
  expect(HUB_ENTRY_FILES.filter((file) => !fs.existsSync(absolute(file)))).toEqual([]);
  expect(
    HUB_ENTRY_FILES.filter((file) => discovered.has(file)),
    'one entry, one rule: a façade is measured as a façade',
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

test.for(platformFacades)('$id evaluates exactly one module: itself', (entry) => {
  const entryPath = absolute(entry.entryFile);
  const graph = eagerClosureGraphOf(entryPath);
  expect(
    graph.size,
    `${entry.id} evaluates ${graph.size} modules on import; a platform façade is metadata-eager ` +
      `and implementation-lazy (ADR-0019).\n${describeClosurePressure(graph, entryPath, repoRoot)}`,
  ).toBe(PLATFORM_FACADE_CLOSURE);
});

test.for(carriedGrowth)('$entry.id evaluates no more modules than at the merge-base', (growth) => {
  const { entry, entryPath, graph, base } = growth;
  const finding = classifyGrowth(entry.id, base.size, graph.size);
  expect(
    finding,
    finding === null
      ? ''
      : `${finding}\n\nNewly evaluated module(s), each by shortest import route from the entry:\n` +
          describeClosureGrowth(graph, base, entryPath, repoRoot),
  ).toBeNull();
});

test('entries that grow by the same new module report shared merge-base homes once', () => {
  // #2423's review: when several entries grow because they all reached the same new module, the
  // per-entry test above already fails once per entry -- this adds ONE more diagnostic naming the
  // modules they already have in common, instead of leaving a reader to notice the repetition
  // across several separate failures by hand. Every carried entry is handed over with its head
  // closure size, and the aggregation itself keeps only the ones the no-growth rule fails
  // (#2471 review) -- so it can only fail alongside at least two already-red entries above and
  // never changes the gate's own pass/fail verdict.
  const growths = carriedGrowth.map((growth) => ({
    id: growth.entry.id,
    added: growth.added,
    baseGraph: growth.baseGraph,
    headClosureSize: growth.graph.size,
  }));
  const shared = describeSharedGrowthHomes(growths, repoRoot);
  expect(
    shared,
    shared === null
      ? ''
      : 'More than one entry grew by the same new module -- see the shared homes below instead ' +
          `of chasing each entry's own diagnostic separately:\n\n${shared}`,
  ).toBeNull();
});

test.for(introduced)(
  '$id is first-introduced and fits the $category ceiling or carries an approval',
  (entry) => {
    const entryPath = absolute(entry.entryFile);
    const graph = eagerClosureGraphOf(entryPath);
    const approved = Object.hasOwn(APPROVED_OVER_CEILING, entry.entryFile);
    const finding = classifyNewEntry(entry.id, entry.category, graph.size, approved);
    expect(
      finding,
      finding === null
        ? ''
        : `${finding}\n\nWhere the weight comes from (heaviest direct edges, capped):\n` +
            describeClosurePressure(graph, entryPath, repoRoot),
    ).toBeNull();
  },
);

test('no APPROVED_OVER_CEILING row is stale', () => {
  // Only a first-introduced entry consults a ceiling. Once the merge-base carries the entry, the
  // no-growth rule governs it and nothing reads the row again, so a carried entry's row is stale
  // for the same reason a shrunk one is: it can no longer change any verdict. Deferred where the
  // merge-base is the head itself and no row is readable at all -- see `staleApprovalRows`.
  const introducedById = new Map(
    introduced.map((entry) => [
      entry.entryFile,
      {
        category: entry.category,
        closureSize: eagerClosureGraphOf(absolute(entry.entryFile)).size,
      },
    ]),
  );
  const stale = staleApprovalRows(
    Object.keys(APPROVED_OVER_CEILING),
    introducedById,
    mergeBase === headCommit(repoRoot),
  );
  expect(
    stale,
    'These approvals name an entry that no longer exists, that the merge-base now carries, or ' +
      'that now fits its ceiling: remove the rows.',
  ).toEqual([]);
});

test.for(entries.filter((entry) => entry.denyPlatformImplementations))(
  '$id never evaluates a concrete platform implementation',
  (entry) => {
    const entryPath = absolute(entry.entryFile);
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
