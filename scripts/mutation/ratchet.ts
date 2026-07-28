// The ratchet itself: scores may only rise, gating is earned, and a score that
// moved for tool/config reasons is never mistaken for test-strength change.
//
// Graduation (issue #1415): the lane starts non-gating. Each comparable weekly
// full sweep with no regression increments `stableRuns`; once it reaches
// `requiredStableRuns` the baseline flips to `gating: true`, after which a
// regression fails the run — weekly as a full sweep, PRs for AFFECTED modules
// only. A regression or a non-comparable run resets the counter to zero.

import { roundScore, type ModuleScore, type SurvivingMutant } from './score.ts';
import type { ModuleId } from './modules.ts';

export const BASELINE_SCHEMA_VERSION = 1;
export const DEFAULT_REQUIRED_STABLE_RUNS = 2;

export type ModuleBaseline = {
  score: number;
  killed: number;
  survived: number;
  total: number;
  // Provenance travels with every module baseline so a tool or config change is
  // distinguishable from a test-strength change.
  strykerVersion: string;
  configHash: string;
  updatedAt: string;
};

export type Baseline = {
  schemaVersion: number;
  requiredStableRuns: number;
  stableRuns: number;
  gating: boolean;
  modules: Record<string, ModuleBaseline>;
};

export type Provenance = { readonly strykerVersion: string; readonly configHash: string };

export type VerdictStatus = 'new' | 'improved' | 'held' | 'regressed' | 'provenance-drift';

export type ModuleVerdict = {
  readonly module: ModuleId;
  readonly score: number;
  readonly killed: number;
  readonly total: number;
  readonly baselineScore: number | undefined;
  readonly delta: number | undefined;
  readonly status: VerdictStatus;
  readonly surviving: readonly SurvivingMutant[];
  readonly detail: string;
};

export type RatchetResult = {
  readonly verdicts: readonly ModuleVerdict[];
  readonly regressions: readonly ModuleVerdict[];
  readonly drifted: readonly ModuleVerdict[];
  /** A run is comparable when every module has a same-provenance baseline. */
  readonly comparable: boolean;
  readonly gating: boolean;
  /** True when the caller must exit non-zero. */
  readonly failed: boolean;
};

export function emptyBaseline(requiredStableRuns: number = DEFAULT_REQUIRED_STABLE_RUNS): Baseline {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    requiredStableRuns,
    stableRuns: 0,
    gating: false,
    modules: {},
  };
}

function driftDetail(previous: ModuleBaseline, provenance: Provenance): string {
  return (
    `baseline recorded by stryker ${previous.strykerVersion} / config ${previous.configHash}, ` +
    `this run used stryker ${provenance.strykerVersion} / config ${provenance.configHash}; ` +
    'the score change is not attributable to test strength — re-record with `pnpm mutation:baseline`'
  );
}

function verdictFor(
  score: ModuleScore,
  previous: ModuleBaseline | undefined,
  provenance: Provenance,
): ModuleVerdict {
  const base = {
    module: score.module,
    score: score.score,
    killed: score.killed,
    total: score.total,
    surviving: score.surviving,
  };
  if (!previous) {
    return {
      ...base,
      baselineScore: undefined,
      delta: undefined,
      status: 'new',
      detail: `no baseline recorded yet (measured ${score.score}%)`,
    };
  }
  const delta = roundScore(score.score - previous.score);
  if (
    previous.strykerVersion !== provenance.strykerVersion ||
    previous.configHash !== provenance.configHash
  ) {
    return {
      ...base,
      baselineScore: previous.score,
      delta,
      status: 'provenance-drift',
      detail: driftDetail(previous, provenance),
    };
  }
  if (delta < 0) {
    return {
      ...base,
      baselineScore: previous.score,
      delta,
      status: 'regressed',
      detail:
        `mutation score fell ${previous.score}% -> ${score.score}% ` +
        `(${score.survived} surviving mutants)`,
    };
  }
  return {
    ...base,
    baselineScore: previous.score,
    delta,
    status: delta > 0 ? 'improved' : 'held',
    detail:
      delta > 0
        ? `mutation score rose ${previous.score}% -> ${score.score}%`
        : `mutation score held at ${score.score}%`,
  };
}

export function evaluateRatchet(
  scores: readonly ModuleScore[],
  baseline: Baseline,
  provenance: Provenance,
): RatchetResult {
  const verdicts = scores.map((score) =>
    verdictFor(score, baseline.modules[score.module], provenance),
  );
  const regressions = verdicts.filter((verdict) => verdict.status === 'regressed');
  const drifted = verdicts.filter((verdict) => verdict.status === 'provenance-drift');
  const comparable = drifted.length === 0 && verdicts.every((v) => v.status !== 'new');
  return {
    verdicts,
    regressions,
    drifted,
    comparable,
    gating: baseline.gating,
    failed: baseline.gating && regressions.length > 0,
  };
}

export type ApplyOptions = {
  readonly provenance: Provenance;
  readonly now: string;
  /** Only the weekly full sweep may advance graduation; affected runs may not. */
  readonly countsTowardGraduation: boolean;
};

/**
 * Fold a run into the baseline: keep the high-water score per module (a
 * regression never rewrites it, so the ratchet keeps failing until the tests are
 * restored), rebase modules whose provenance drifted onto the new tool/config,
 * then advance or reset graduation.
 */
export function applyRun(
  baseline: Baseline,
  scores: readonly ModuleScore[],
  result: RatchetResult,
  options: ApplyOptions,
): Baseline {
  const modules: Record<string, ModuleBaseline> = { ...baseline.modules };
  for (const score of scores) {
    const previous = modules[score.module];
    const status = result.verdicts.find((verdict) => verdict.module === score.module)?.status;
    const rebase = !previous || status === 'provenance-drift';
    if (!rebase && score.score < previous.score) continue;
    modules[score.module] = {
      score: rebase ? score.score : Math.max(previous.score, score.score),
      killed: score.killed,
      survived: score.survived,
      total: score.total,
      strykerVersion: options.provenance.strykerVersion,
      configHash: options.provenance.configHash,
      updatedAt: options.now,
    };
  }

  const stable = result.comparable && result.regressions.length === 0;
  const stableRuns = !options.countsTowardGraduation
    ? baseline.stableRuns
    : stable
      ? baseline.stableRuns + 1
      : 0;
  return {
    ...baseline,
    schemaVersion: BASELINE_SCHEMA_VERSION,
    stableRuns,
    gating: stableRuns >= baseline.requiredStableRuns,
    modules,
  };
}
