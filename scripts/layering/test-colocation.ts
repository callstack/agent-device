// Catches: a unit test that sits beside no module it is named for, so a reader of a module cannot
//   find its tests and a test cannot say which module it pins. Every `*.test.ts` under root `src/`
//   and `packages/<pkg>/src/` sits in the directory of a module (or in that directory's
//   `__tests__/`), and its name is that module's name or the module's name plus `-<aspect>`:
//   `session-store.test.ts` and `session-store-recovery.test.ts` for `session-store.ts`.
//   The offender set only shrinks: it is measured at the merge-base with origin/main by the same
//   function that measures the working tree (`ratchet-reference.ts`), so a new unmatched test
//   fails, a move or rename into place needs no edit, and no baseline file exists to append to.
// Evidence: when the rule landed, a fifth of the unit tests matched no module (most under
//   `src/__tests__/daemon-composition`, the rest across `src/__tests__`, the daemon's handler
//   trees and platform-apple's runner), so "tests mirror source topology one-to-one" (AGENTS.md)
//   was a sentence with no enforcement; the live count is in the check:layering output.
// Cost: one pass over the tracked file list per tree.
// Kill criterion: a maintainer decision that tests need not sit beside the modules they test.
//
// R84 test-colocation. Two conventions keep the rule free of exemptions:
//   - Cross-module package tests (conformance drivers, package-surface tests) are named for the
//     package entry: `index-<aspect>.test.ts` beside `index.ts`. `index` is an ordinary module.
//   - Repo-level guards (tests that assert on Swift sources, manifests, docs or scripts) live in
//     `test/repo-guards/` and run in `unit-core`.
// `test/` (integration, e2e, wire-compat, repo guards) and `scripts/` are exempt: the rule reads
// only root `src/` and package `src/` trees, and not test-kit, whose sources are test support. A
// module is any production source file (`isProductionSourceFile`): fixtures never count as the
// module a test is named for.

import path from 'node:path';
import type { LayeringViolation } from './model.ts';
import { isProductionSourceFile, SOURCE_TREE_ROOT } from './tracked-sources.ts';

export const TEST_COLOCATION_RULE = 'R84 test-colocation';

const TEST_KIT_TREE = 'packages/test-kit/';

function inScope(file: string): boolean {
  return SOURCE_TREE_ROOT.test(file) && !file.startsWith(TEST_KIT_TREE);
}
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** The directory whose modules a test is judged against: its own, or the parent of `__tests__`. */
function moduleDirectory(testFile: string): string {
  const dir = path.posix.dirname(testFile);
  return path.posix.basename(dir) === '__tests__' ? path.posix.dirname(dir) : dir;
}

/**
 * Every in-scope unit test, sorted, that is named for no module in its module directory. `files`
 * is one tree's tracked paths.
 */
export function measureUnmatchedTests(files: readonly string[]): string[] {
  const modulesByDirectory = new Map<string, string[]>();
  for (const file of files) {
    if (!inScope(file) || !isProductionSourceFile(file)) continue;
    const dir = path.posix.dirname(file);
    const modules = modulesByDirectory.get(dir) ?? [];
    modules.push(path.posix.basename(file).replace(/(?:\.d)?\.ts$/, ''));
    modulesByDirectory.set(dir, modules);
  }
  const unmatched: string[] = [];
  for (const file of files) {
    if (!inScope(file) || !TEST_FILE.test(file)) continue;
    const name = path.posix.basename(file).replace(TEST_FILE, '');
    const modules = modulesByDirectory.get(moduleDirectory(file)) ?? [];
    if (!modules.some((module) => name === module || name.startsWith(`${module}-`))) {
      unmatched.push(file);
    }
  }
  return unmatched.sort();
}

/**
 * Growth fails: an unmatched test at head that the merge-base did not already hold. Base entries
 * arrive in head coordinates, so a test moved or renamed since the merge-base is the same entry.
 */
export function checkTestColocation(
  head: readonly string[],
  base: readonly string[],
): LayeringViolation[] {
  const held = new Set(base);
  return head
    .filter((file) => !held.has(file))
    .map((file) => ({
      rule: TEST_COLOCATION_RULE,
      file,
      line: 1,
      message:
        `${path.posix.basename(file)} is named for no module in ${moduleDirectory(file)}/. Name it ` +
        `<module>.test.ts or <module>-<aspect>.test.ts for a module there (index-<aspect>.test.ts ` +
        `for a cross-module package test, beside index.ts), move it beside its module, or, for a ` +
        `repo-level guard on Swift sources, manifests, docs or scripts, move it to ` +
        `test/repo-guards/.`,
    }));
}

/** The `R84` success-line fragment: how many unmatched tests remain, against the merge-base. */
export function testColocationSummary(head: readonly string[], base: readonly string[]): string {
  return (
    `every new unit test is named for a module beside it: ${head.length} unmatched test(s) ` +
    `remain against ${base.length} at the merge-base (R84)`
  );
}
