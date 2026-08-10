// Does a category's own gate actually fire on a PR that only touches that category?
//
// This is the #1420 hole generalized. ci.yml's `paths-ignore: website/**` is the worked
// example: the gate exists, its job exists, and the job never runs for the change it is meant
// to gate. Nothing about that reads as broken from any single side.
//
// A category here is one of the affected-selector's ownership rules (selector-rules.ts derives
// that universe from the selector's source). Each is represented by a sample path, and the
// samples are themselves checked for completeness — `unrepresentedRules` fails when the
// selector grows a rule no sample exercises, so the list cannot quietly fall behind.

import type { CatalogEntry } from './catalog-wiring.ts';
import { triggersOnPath } from './path-filters.ts';
import { lanesByCheckName, type Lane, type WorkflowFile } from './workflow-lanes.ts';

export type PathCategory = {
  /** A representative repo path for the category. */
  readonly path: string;
  readonly label: string;
  /** Check ids the affected-selector routes this path to. */
  readonly checks: readonly string[];
  /** Selector rule ids this path exercises — what makes it representative of a category. */
  readonly rules: readonly string[];
};

export type PathReachabilityMiss = {
  readonly category: string;
  readonly path: string;
  readonly check: string;
  readonly job: string;
  readonly workflow: string;
};

/**
 * Selector rules no sample path exercises. Each is a category whose reachability this gate
 * cannot speak for, so it fails rather than reporting a green it has not earned.
 */
export function unrepresentedRules(
  selectorRules: readonly string[],
  categories: readonly PathCategory[],
): string[] {
  const covered = new Set(categories.flatMap((category) => [...category.rules]));
  return selectorRules.filter((rule) => !covered.has(rule));
}

/**
 * Categories whose owning jobs all fail to trigger on the category's own path. The check runs
 * per (category, check) pair and reports every job the catalog named, so the message says both
 * what stopped being gated and where the owning job lives.
 */
export function unreachablePathCategories(
  categories: readonly PathCategory[],
  catalog: readonly CatalogEntry[],
  workflows: readonly WorkflowFile[],
  lanes: readonly Lane[],
  waived: ReadonlySet<string>,
): PathReachabilityMiss[] {
  const byName = lanesByCheckName(lanes);
  const triggersByFile = new Map(workflows.map((workflow) => [workflow.file, workflow.triggers]));
  const firesOnPath = (job: string, file: string): boolean =>
    (byName.get(job) ?? []).some((lane) => {
      const triggers = triggersByFile.get(lane.workflow);
      return triggers !== undefined && triggersOnPath(triggers, file);
    });

  const misses: PathReachabilityMiss[] = [];
  for (const category of categories) {
    for (const check of category.checks) {
      if (waived.has(`${category.label}@${check}`)) continue;
      const entry = catalog.find((candidate) => candidate.id === check);
      if (!entry || entry.ciJobs.some((job) => firesOnPath(job, category.path))) continue;
      for (const job of entry.ciJobs) {
        const lane = (byName.get(job) ?? [])[0];
        misses.push({
          category: category.label,
          path: category.path,
          check,
          job,
          workflow: lane?.workflow ?? '(no workflow defines this job)',
        });
      }
    }
  }
  return misses;
}
