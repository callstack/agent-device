// Mirrored-test resolution for one production file, in priority order: the same directory, a
// sibling `__tests__/`, then `test/` or `__tests__/` under the family root by shortest path. A
// match whose own family differs is marked foreign so the evidence can say "its test lives
// elsewhere" without naming where. A test's family is read from the production location it
// mirrors (`__tests__/` dropped), so `src/__tests__/cli.test.ts` belongs to `(root)`, not to a
// phantom `__tests__` family.

import path from 'node:path';
import type { FamilyOf } from '../coupling/modularity.ts';

export type TestMirrorRule = 'same-dir' | 'sibling-tests' | 'family-root';

export type TestMirror = {
  path: string;
  basename: string;
  foreign: boolean;
  rule: TestMirrorRule;
};

export type TestIndex = {
  byBasename: ReadonlyMap<string, readonly string[]>;
  all: ReadonlySet<string>;
};

export function indexTestFiles(testFiles: Iterable<string>): TestIndex {
  const byBasename = new Map<string, string[]>();
  const all = new Set<string>();
  for (const file of testFiles) {
    all.add(file);
    const base = path.posix.basename(file);
    const list = byBasename.get(base) ?? [];
    list.push(file);
    byBasename.set(base, list);
  }
  for (const list of byBasename.values()) {
    list.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }
  return { byBasename, all };
}

/** The directory a family's tests may sit under: `packages/<pkg>/src` or `src/<folder>`. */
export function familyRoot(file: string): string {
  const packageMatch = /^(packages\/[^/]+\/src)\//.exec(file);
  if (packageMatch) return packageMatch[1]!;
  const srcMatch = /^(src\/[^/]+)\//.exec(file);
  return srcMatch ? srcMatch[1]! : 'src';
}

/** The production path a test file mirrors: its `__tests__/` segment removed. */
export function mirroredProductionPath(testFile: string): string {
  return testFile.replace(/(^|\/)__tests__\//, '$1');
}

export function resolveTestMirror(
  file: string,
  index: TestIndex,
  familyOf: FamilyOf,
): TestMirror | null {
  const dir = path.posix.dirname(file);
  const basename = `${path.posix.basename(file, '.ts')}.test.ts`;
  const found = (candidate: string, rule: TestMirrorRule): TestMirror => ({
    path: candidate,
    basename,
    rule,
    foreign: familyOf(mirroredProductionPath(candidate)) !== familyOf(file),
  });

  const sameDir = path.posix.join(dir, basename);
  if (index.all.has(sameDir)) return found(sameDir, 'same-dir');
  const sibling = path.posix.join(dir, '__tests__', basename);
  if (index.all.has(sibling)) return found(sibling, 'sibling-tests');

  const root = familyRoot(file);
  const underRoot = (index.byBasename.get(basename) ?? []).find(
    (candidate) =>
      candidate.startsWith(`${root}/test/`) || candidate.startsWith(`${root}/__tests__/`),
  );
  return underRoot ? found(underRoot, 'family-root') : null;
}
