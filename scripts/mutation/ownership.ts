// Which kernel module a changed file belongs to, DERIVED — never hand-listed.
//
// A mutation score is a statement about the tests that kill the mutants, so a
// selection is only honest if it follows *those* tests. An enumerated list of
// test files cannot state that: it silently omits tests that
// exercise a kernel indirectly (`src/__tests__/daemon-error.test.ts` reaches
// `normalizeError` through `src/daemon.ts`), and nothing fails when a new test
// is added. So ownership is computed from the static import graph instead: a test
// file owns every kernel module whose mutated sources it can reach.
//
// The derivation is deliberately a superset — reaching a kernel is cheaper to
// prove than killing its mutants, so an unrelated diff can select a module and
// pay for a report. False positives cost runner minutes; a false negative would
// leave a kernel whose tests changed unmeasured.
//
// Non-test source changes outside the registry are NOT owned: they can only move
// a score through the tests that reach the kernel, and the weekly full sweep is
// what re-measures the whole surface. The derived claim is narrower on purpose —
// kernel sources plus the tests that exercise them.

import fs from 'node:fs';
import path from 'node:path';
import {
  readWorkspacePackages,
  workspaceSpecifierTargets,
} from '../layering/package-boundaries.ts';
import { walkFiles } from '../lib/walk-files.ts';
import {
  affectedModules,
  isKernelTestFile,
  KERNEL_MODULES,
  normalizePath,
  type ModuleId,
  type KernelModule,
} from './modules.ts';
import { expandMutateFiles } from './test-scope.ts';

/** Test files the mutation lane can attribute to a kernel at all. */
export function isTestFile(filePath: string): boolean {
  return isKernelTestFile(filePath);
}

/**
 * Workspace package specifiers resolved through the shared exports-map reader
 * (scripts/layering/package-boundaries.ts) — never hand-listed. Without this
 * the graph walk stops at every `@agent-device/*` edge and a kernel living in
 * `packages/` silently loses all of its owned tests.
 */
let cachedExportTargets: { repoRoot: string; targets: Map<string, string> } | undefined;

function exportTargetsFor(repoRoot: string): Map<string, string> {
  if (cachedExportTargets?.repoRoot !== repoRoot) {
    cachedExportTargets = { repoRoot, targets: workspaceSpecifierTargets(repoRoot) };
  }
  return cachedExportTargets.targets;
}

/**
 * Repository-relative modules a file imports: relative specifiers plus
 * workspace package specifiers resolved through their `exports` maps.
 */
function importsOf(file: string, repoRoot: string, cache: Map<string, string[]>): string[] {
  const cached = cache.get(file);
  if (cached) return cached;
  const absolute = path.join(repoRoot, file);
  const text = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*'(?<spec>[.@][^']+)'/g)].map(
    (match) => match.groups!.spec,
  );
  const exportTargets = exportTargetsFor(repoRoot);
  const resolved = [
    ...new Set(
      specifiers.flatMap((specifier) => {
        if (specifier.startsWith('@')) {
          const target = exportTargets.get(specifier);
          return target && fs.existsSync(path.join(repoRoot, target)) ? [target] : [];
        }
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        return [base, `${base}.ts`, `${base}/index.ts`].filter((candidate) =>
          fs.existsSync(path.join(repoRoot, candidate)),
        );
      }),
    ),
  ].filter((candidate) => candidate.endsWith('.ts'));
  cache.set(file, resolved);
  return resolved;
}

/** Every repository-relative module `file` reaches through the import graph. */
export function reachableFrom(
  file: string,
  repoRoot: string,
  cache: Map<string, string[]> = new Map(),
): Set<string> {
  const seen = new Set<string>();
  const queue = [normalizePath(file)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...importsOf(current, repoRoot, cache));
  }
  return seen;
}

/** The concrete sources Stryker mutates for a module. */
export function mutatedSources(module: KernelModule, repoRoot: string): string[] {
  return expandMutateFiles(module.mutate, repoRoot);
}

type Deriver = {
  /** Kernel modules a single test file exercises, in registry order. */
  ownersOf: (testFile: string) => ModuleId[];
};

/** A deriver with caches shared across files — one graph walk per module, not per query. */
export function ownershipDeriver(repoRoot: string): Deriver {
  const importCache = new Map<string, string[]>();
  const sources = KERNEL_MODULES.map((module) => ({
    id: module.id,
    sources: new Set(mutatedSources(module, repoRoot)),
  }));
  return {
    ownersOf(testFile) {
      const reachable = reachableFrom(testFile, repoRoot, importCache);
      return sources
        .filter((entry) => [...entry.sources].some((source) => reachable.has(source)))
        .map((entry) => entry.id);
    },
  };
}

/**
 * Kernel modules a diff affects: registry-owned paths plus every module the
 * changed tests reach. Registry order, deduplicated.
 */
export function derivedAffectedModules(
  changedFiles: readonly string[],
  repoRoot: string,
): ModuleId[] {
  const ids = new Set<ModuleId>(affectedModules(changedFiles));
  const tests = changedFiles.filter(isTestFile).map(normalizePath);
  if (tests.length > 0) {
    const deriver = ownershipDeriver(repoRoot);
    for (const testFile of tests) {
      for (const id of deriver.ownersOf(testFile)) ids.add(id);
    }
  }
  return KERNEL_MODULES.filter((module) => ids.has(module.id)).map((module) => module.id);
}

/**
 * Every test file in the repository, per module that owns it — one graph walk
 * over root `src/` plus every workspace package's `src/`, so a kernel tested
 * only from inside its own package (`target-annotation-serde`) is not
 * silently unownable.
 */
export function ownedTestFiles(repoRoot: string): Map<ModuleId, string[]> {
  const deriver = ownershipDeriver(repoRoot);
  const owned = new Map<ModuleId, string[]>(KERNEL_MODULES.map((module) => [module.id, []]));
  const testRoots = [
    path.join(repoRoot, 'src'),
    ...readWorkspacePackages(repoRoot).map((pkg) => path.join(repoRoot, pkg.dir, 'src')),
  ];
  for (const root of testRoots) {
    for (const file of walkFiles(root, (file) => file.endsWith('.test.ts'))) {
      const relative = normalizePath(path.relative(repoRoot, file));
      for (const id of deriver.ownersOf(relative)) owned.get(id)!.push(relative);
    }
  }
  for (const files of owned.values()) files.sort();
  return owned;
}
