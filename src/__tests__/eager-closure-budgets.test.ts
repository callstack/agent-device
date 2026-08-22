import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eagerClosureOf } from './eager-import-closure.fixtures.ts';
import {
  EAGER_CLOSURE_BUDGETS,
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
 * probe, generalized to every workspace-package façade plus designated hub modules, driven by the
 * data table in `eager-closure-budgets.ts` instead of one-off pins.
 *
 * - Catches: a façade or vocabulary entry silently going eager -- the regression class #1950
 *   fixed once (the android teardown-helper pin below) and #1956/#1959 fix at two more sites.
 *   Before this file, nothing prevented a fourth instance: layering R3/R13 govern import
 *   *direction* (may this file import that one at all), not *evaluation weight* (how much of the
 *   repo importing it drags along).
 * - Evidence: the planted-red procedure that proved the #1950 pin re-verified here (see the git
 *   history on this file's introduction for the observed failing run); simulation on the whole
 *   unit-core suite showed single-file regressions of this class cost 5-12% of the suite's total
 *   import work each.
 * - Cost: one unit-lane test file plus one data module; the walker parses each reachable file once
 *   per entry (whole-table run is a fraction of a second), no subprocess, no device.
 * - Kill criterion: if two consecutive quarters show no budget ever tightening or firing, or
 *   ADR-0019 composition lands a stronger structural proof of the loading shape, delete this gate
 *   in favor of that proof.
 */

const repoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Every `.ts` file under a `src/facades/` directory, discovered the same way
 * `package-boundaries.test.ts` discovers façades (directory membership, not a hand-maintained
 * list) -- so a new façade directory shows up here, and must gain a table entry, the moment it
 * exists.
 */
function discoverFacadeFiles(): string[] {
  const packagesDir = path.join(repoRoot, 'packages');
  const files: string[] = [];
  for (const pkgEntry of fs.readdirSync(packagesDir).sort()) {
    const facadesDir = path.join(packagesDir, pkgEntry, 'src/facades');
    if (!fs.existsSync(facadesDir)) continue;
    for (const file of fs.readdirSync(facadesDir).sort()) {
      if (file.endsWith('.ts')) files.push(path.join(facadesDir, file));
    }
  }
  return files;
}

function relList(files: readonly string[]): string[] {
  return [...files].map((file) => path.relative(repoRoot, file)).sort();
}

test('every discovered façade has exactly one budget entry, and no budget entry is stale', () => {
  // Bidirectional, mirroring the repo's other exhaustiveness gates (R7/R10 field checklists,
  // the facade-exports exhaustive re-export check): a façade with no budget would let this whole
  // mechanism go silently vacuous for it, and a budget entry for a file that is no longer a
  // façade would let the table drift from what it claims to police.
  const discovered = new Set(discoverFacadeFiles());
  const facadeEntries = EAGER_CLOSURE_BUDGETS.filter((entry) => entry.kind === 'facade');
  const budgeted = new Set(facadeEntries.map((entry) => path.resolve(repoRoot, entry.entryFile)));

  const missingBudget = relList([...discovered].filter((file) => !budgeted.has(file)));
  const staleBudget = relList([...budgeted].filter((file) => !discovered.has(file)));

  expect(
    missingBudget,
    'These façades exist under a `src/facades/` directory but have no entry in ' +
      'eager-closure-budgets.ts. Add one (measure the current closure size with eagerClosureOf ' +
      'and round up a few files for headroom), or the loading-shape probe silently does not ' +
      'cover them.',
  ).toEqual([]);
  expect(
    staleBudget,
    "These eager-closure-budgets.ts entries are marked kind: 'facade' but no longer name a file " +
      'under a `src/facades/` directory. Remove the stale entry or fix its path.',
  ).toEqual([]);
});

test('every budgeted entry file exists on disk', () => {
  const missing = EAGER_CLOSURE_BUDGETS.filter(
    (entry) => !fs.existsSync(path.resolve(repoRoot, entry.entryFile)),
  ).map((entry) => entry.entryFile);
  expect(
    missing,
    'These eager-closure-budgets.ts entries name a file that does not exist.',
  ).toEqual([]);
});

test.for(EAGER_CLOSURE_BUDGETS)(
  '$id stays within its eager-closure budget of $budget modules',
  (entry: EagerClosureBudget) => {
    const closure = eagerClosureOf(path.resolve(repoRoot, entry.entryFile));
    const evaluated = relList(closure);
    expect(
      closure.length,
      `${entry.id} evaluates ${closure.length} modules on import, over its budget of ` +
        `${entry.budget}. Either the budget needs a reviewed increase (name what legitimately ` +
        'grew and why), or something that used to load on demand now loads eagerly -- check the ' +
        'newest entries below against what this entry point should need.\nEvaluated ' +
        `(${evaluated.length}):\n${evaluated.join('\n')}`,
    ).toBeLessThanOrEqual(entry.budget);
  },
);

test.for(EAGER_CLOSURE_BUDGETS.filter((entry) => entry.denyPlatformImplementations))(
  '$id never evaluates a concrete platform implementation before discovery/binding',
  (entry: EagerClosureBudget) => {
    const closure = eagerClosureOf(path.resolve(repoRoot, entry.entryFile));
    const offenders = relList(
      closure.filter((file) =>
        PLATFORM_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(file)),
      ),
    );
    expect(
      offenders,
      `${entry.id} is implementation-neutral vocabulary (ADR-0019) and must not evaluate a ` +
        'concrete platform implementation until discovery/binding selects one. Load the ' +
        `offending module(s) on demand instead of with a static value import:\n${offenders.join('\n')}`,
    ).toEqual([]);
  },
);
