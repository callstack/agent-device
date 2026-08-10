// CHECK_CATALOG.ciJobs, checked rather than trusted.
//
// The catalog (scripts/check-affected/checks.ts) names the CI jobs each check mirrors as free
// strings. Nothing proved those names matched live jobs, which is the first verified hole
// #1429 was opened for: rename a job and the catalog entry quietly points at nothing.

import { lanesByCheckName, type Lane } from './workflow-lanes.ts';
import { packageScriptSuite } from './suite-ownership.ts';
import type { ResolveContext, Terminal } from './execution-terminals.ts';

export type CatalogEntry = {
  readonly id: string;
  readonly script: string | null;
  readonly ciJobs: readonly string[];
};

export type CatalogJobMiss = {
  readonly check: string;
  readonly job: string;
  /** Job names that do exist, for the "naming both sides" failure message. */
  readonly known: readonly string[];
};

/** Catalog entries pointing at a CI job that no workflow defines — the #1429 primary hole. */
export function missingCatalogJobs(
  catalog: readonly CatalogEntry[],
  lanes: readonly Lane[],
): CatalogJobMiss[] {
  const known = new Set(lanes.flatMap((lane) => [...lane.checkNames]));
  const sortedKnown = [...known].sort();
  return catalog.flatMap((entry) =>
    entry.ciJobs
      .filter((job) => !known.has(job))
      .map((job) => ({ check: entry.id, job, known: sortedKnown })),
  );
}

export type CatalogReachabilityMiss = {
  readonly check: string;
  readonly jobs: readonly string[];
  readonly missing: readonly Terminal[];
};

/**
 * A catalog entry claims its script is mirrored by its `ciJobs` — plural, and collectively:
 * `unit` names both Coverage (which runs the Vitest projects) and Integration Tests (which runs
 * the smoke suite), and neither runs the whole script alone. So the claim under test is that
 * the UNION of the named jobs reaches every terminal the script does.
 *
 * This is what makes the catalog's `ciJobs` a checked statement rather than a comment. A
 * renamed intermediate script breaks the chain and surfaces here, instead of leaving the claim
 * standing over work that no longer runs.
 */
export function unreachableCatalogClaims(
  catalog: readonly CatalogEntry[],
  lanes: readonly Lane[],
  ctx: ResolveContext,
  waived: ReadonlySet<string>,
): CatalogReachabilityMiss[] {
  const byName = lanesByCheckName(lanes);
  const misses: CatalogReachabilityMiss[] = [];
  for (const entry of catalog) {
    if (entry.script === null) continue;
    if (waived.has(entry.id)) continue;
    const command = ctx.packageScripts.get(entry.script);
    if (command === undefined) continue; // resolveCommand in checks.ts already fails on this.
    const suite = packageScriptSuite(entry.script, command, ctx);
    const claimed = entry.ciJobs.flatMap((job) => byName.get(job) ?? []);
    if (claimed.length === 0) continue; // missingCatalogJobs reports this.
    const reachable = new Set(claimed.flatMap((lane) => [...lane.terminals]));
    const missing = [...suite.terminals].filter((terminal) => !reachable.has(terminal)).sort();
    if (missing.length > 0) misses.push({ check: entry.id, jobs: entry.ciJobs, missing });
  }
  return misses;
}
