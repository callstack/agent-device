// Per-module mutation scores derived from a Stryker JSON report.

import { ALL_MODULE_IDS, moduleForFile, normalizePath, type ModuleId } from './modules.ts';

/** The subset of Stryker's JSON report schema this lane reads. */
export type StrykerMutant = {
  readonly mutatorName?: string;
  readonly status: string;
  readonly location?: { readonly start?: { readonly line?: number } };
};

export type StrykerReport = {
  readonly files: Record<string, { readonly mutants: readonly StrykerMutant[] }>;
};

export type SurvivingMutant = {
  readonly file: string;
  readonly line: number;
  readonly mutator: string;
};

export type ModuleScore = {
  readonly module: ModuleId;
  readonly score: number;
  readonly killed: number;
  readonly survived: number;
  readonly total: number;
  readonly surviving: readonly SurvivingMutant[];
};

// Stryker counts a timeout as killed. `NoCoverage` counts as survived here: an
// uncovered mutant is precisely the "decorative test" signal this lane exists to
// surface. Every other status (Ignored, CompileError, RuntimeError) leaves the
// denominator, so tool-side noise cannot move the score.
const KILLED_STATUSES = new Set(['Killed', 'Timeout']);
const SURVIVED_STATUSES = new Set(['Survived', 'NoCoverage']);

/**
 * Merge sharded Stryker reports into one. The weekly sweep runs one shard per
 * kernel module so no single job approaches its time budget; the ratchet still
 * evaluates a single full-sweep report.
 */
export function mergeReports(reports: readonly StrykerReport[]): StrykerReport {
  const files: Record<string, { mutants: StrykerMutant[] }> = {};
  for (const report of reports) {
    for (const [file, entry] of Object.entries(report.files)) {
      const existing = files[file];
      if (existing) existing.mutants.push(...entry.mutants);
      else files[file] = { mutants: [...entry.mutants] };
    }
  }
  return { files };
}

export function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function compareMutants(a: SurvivingMutant, b: SurvivingMutant): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.mutator.localeCompare(b.mutator);
}

export function summarizeReport(
  report: StrykerReport,
  ids: readonly ModuleId[] = ALL_MODULE_IDS,
): ModuleScore[] {
  const buckets = new Map<
    ModuleId,
    { killed: number; survived: number; surviving: SurvivingMutant[] }
  >();
  for (const id of ids) buckets.set(id, { killed: 0, survived: 0, surviving: [] });

  for (const [file, entry] of Object.entries(report.files)) {
    const id = moduleForFile(file);
    if (!id) continue;
    const bucket = buckets.get(id);
    if (!bucket) continue;
    for (const mutant of entry.mutants) {
      if (KILLED_STATUSES.has(mutant.status)) {
        bucket.killed += 1;
      } else if (SURVIVED_STATUSES.has(mutant.status)) {
        bucket.survived += 1;
        bucket.surviving.push({
          file: normalizePath(file),
          line: mutant.location?.start?.line ?? 0,
          mutator: mutant.mutatorName ?? 'unknown',
        });
      }
    }
  }

  return [...buckets].map(([module, bucket]) => {
    const total = bucket.killed + bucket.survived;
    return {
      module,
      score: total === 0 ? 0 : roundScore((bucket.killed / total) * 100),
      killed: bucket.killed,
      survived: bucket.survived,
      total,
      surviving: bucket.surviving.sort(compareMutants),
    };
  });
}
