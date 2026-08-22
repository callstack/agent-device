import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eagerClosureGraphOf } from './eager-import-closure.fixtures.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import {
  classifyBudget,
  describeClosurePressure,
  discoverFacadeEntryFiles,
  EAGER_CLOSURE_BUDGETS,
  FACADE_BUDGETS,
  formatImportChain,
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
 * (`eager-import-closure.fixtures.ts`, AST-level: static value edges plus top-level dynamic
 * imports, type-only erased) and proved the planted-red procedure on one file. This is that
 * probe, generalized to every workspace-package entry surface plus designated hub modules.
 *
 * - Catches: an entry surface or vocabulary module silently going eager -- the regression class
 *   #1950 fixed once and #1959/#1969 fixed at five more sites. Nothing else prevents the next
 *   instance: layering R3/R13 govern import DIRECTION (may this file reach that one at all),
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

function relList(files: readonly string[]): string[] {
  return [...files].map((file) => path.relative(repoRoot, file)).sort();
}

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
  // The hole: printing a chain per evaluated module is unusable at src/cli.ts scale (361), so a
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
  expect(described).toContain('heavy.ts -- 3 module(s) enter through this edge');
  expect(described.indexOf('heavy.ts')).toBeLessThan(described.indexOf('light.ts'));
  expect(described, 'the deep route must be shown, not just the edge name').toContain('heavy-3.ts');
  expect(described, 'output must be capped and say how much it omitted').toMatch(
    /\(\+\d+ more direct edge\(s\), smaller\)/,
  );
  expect(described.split('\n').length).toBeLessThan(20);
});

test('an entry that evaluates only itself is described without pretending to an edge', () => {
  // The six platform façades are exactly this shape, so the message they would print matters.
  const graph = new Map<string, string | null>([['/repo/solo.ts', null]]);
  expect(describeClosurePressure(graph, '/repo/solo.ts', '/repo')).toContain('only itself');
});

test('discovery is recursive, so a NESTED facade file cannot hide from the gate', () => {
  // The hole: a one-level `readdir` of `src/facades` omits `src/facades/nested/x.ts`, which R11's
  // recursive scan covers -- the two gates would disagree about what a façade is, and this one
  // would be the lenient half. Exercised against a fixture tree so it holds even while the real
  // repo happens to have no nested façade.
  const fixtureRoot = mkdtempForTestSync('eager-closure-discovery-');
  const pkgDir = path.join(fixtureRoot, 'packages/demo');
  fs.mkdirSync(path.join(pkgDir, 'src/facades/nested'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@agent-device/demo', exports: { '.': './src/entry.ts' } }),
  );
  fs.writeFileSync(path.join(pkgDir, 'src/entry.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/top.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/nested/deep.ts'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/skip.test.ts'), 'export const d = 4;\n');

  const discovered = discoverFacadeEntryFiles(fixtureRoot);
  expect(discovered).toContain('packages/demo/src/entry.ts'); // manifest-declared
  expect(discovered).toContain('packages/demo/src/facades/top.ts');
  expect(discovered).toContain('packages/demo/src/facades/nested/deep.ts'); // the regression
  expect(discovered, 'test sources are not entry surfaces').not.toContain(
    'packages/demo/src/facades/skip.test.ts',
  );
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
    const chains = offenders.map((file) => formatImportChain(graph, file, repoRoot)).sort();

    expect(
      relList(offenders),
      `${entry.id} must not evaluate a concrete platform implementation before discovery or ` +
        'binding selects an owner (ADR-0019: the registry is metadata-eager and ' +
        'implementation-lazy). Move the offending edge behind a function-scoped `await import`. ' +
        `The chains that reach implementation:\n\n${chains.join('\n\n')}`,
    ).toEqual([]);
  },
);
