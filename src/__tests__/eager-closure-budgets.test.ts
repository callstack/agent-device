import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eagerClosureGraphOf } from './eager-import-closure.fixtures.ts';
import {
  discoverFacadeEntryFiles,
  EAGER_CLOSURE_BUDGETS,
  formatImportChain,
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
 * probe, generalized to every workspace-package entry surface plus designated hub modules, driven
 * by the table in `eager-closure-budgets.ts` instead of one-off pins.
 *
 * - Catches: an entry surface or vocabulary module silently going eager -- the regression class
 *   #1950 fixed once and #1959/#1969 fixed at five more sites. Nothing else prevents the next
 *   instance: layering R3/R13 govern import DIRECTION (may this file reach that one at all),
 *   never evaluation WEIGHT (how much of the repo an importer drags along).
 * - Evidence: planted red re-verified against this gate itself, not merely cited from #1950 --
 *   see the PR description for the observed failure, including the printed edge chain.
 * - Cost: one unit-lane test file plus one data module; no subprocess, no device. The walker
 *   memoizes per-file edges, so the ~100 entries parse each reachable file once in total.
 * - Kill criterion: if two consecutive quarters show no budget ever tightening or firing, or
 *   ADR-0019 composition lands a stronger structural proof of the loading shape, delete this gate
 *   in favor of that proof.
 */

const repoRoot = path.resolve(import.meta.dirname, '../..');

function relList(files: readonly string[]): string[] {
  return [...files].map((file) => path.relative(repoRoot, file)).sort();
}

test('every discovered entry surface has exactly one budget entry, and none is stale', () => {
  // Bidirectional, mirroring the repo's other exhaustiveness gates (R7/R10 field checklists, the
  // R11 exhaustive re-export check): an entry surface with no budget lets this whole mechanism go
  // silently vacuous for it -- which is exactly how the first version of this gate missed all six
  // platform-package façades -- and a budget naming a file that is no longer an entry surface lets
  // the table drift from what it claims to police.
  const discovered = new Set(discoverFacadeEntryFiles(repoRoot));
  const budgeted = new Set(
    EAGER_CLOSURE_BUDGETS.filter((entry) => entry.kind === 'facade').map(
      (entry) => entry.entryFile,
    ),
  );

  const missingBudget = [...discovered].filter((file) => !budgeted.has(file)).sort();
  const staleBudget = [...budgeted].filter((file) => !discovered.has(file)).sort();

  expect(
    missingBudget,
    'These package entry surfaces (a package.json `exports` target, or a file under a ' +
      '`src/facades/` directory) have no entry in eager-closure-budgets.ts. Measure the current ' +
      'closure size with eagerClosureOf and add a row, or the loading-shape probe does not ' +
      'actually cover them.',
  ).toEqual([]);
  expect(
    staleBudget,
    "These eager-closure-budgets.ts rows are marked kind: 'facade' but are no longer a package " +
      'entry surface. Remove the stale row or fix its path.',
  ).toEqual([]);
});

test('discovery is manifest-derived, so it reaches entries with no facades/ directory', () => {
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

test.for(EAGER_CLOSURE_BUDGETS)(
  '$id evaluates at most $budget modules',
  (entry: EagerClosureBudget) => {
    const entryPath = path.resolve(repoRoot, entry.entryFile);
    const graph = eagerClosureGraphOf(entryPath);
    // Report the newest arrivals by their import chain rather than dumping a sorted set: the
    // chain is what turns "this is over budget" into "this import is why" (#1960).
    const chains = [...graph.keys()]
      .filter((file) => file !== entryPath)
      .map((file) => formatImportChain(graph, file, repoRoot))
      .sort();
    expect(
      graph.size,
      `${entry.id} evaluates ${graph.size} modules on import, over its budget of ${entry.budget}.` +
        '\nBudgets here are exact ratchets, not ceilings with slack: either something that used ' +
        'to load on demand now loads eagerly (fix the import), or the growth is deliberate and ' +
        'this row moves to the new number in the same PR.\nEvery evaluated module, as the import ' +
        `chain that pulled it in:\n\n${chains.join('\n\n')}`,
    ).toBeLessThanOrEqual(entry.budget);
  },
);

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
