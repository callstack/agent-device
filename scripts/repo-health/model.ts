// Repo-health snapshot model — pure aggregation over the analyzers this repo already runs.
//
// The snapshot is DATA for agents to query (issue #1423, Track C of #1412), not a dashboard and
// not a new gate. Every metric here is REUSED from an existing analyzer rather than recomputed:
// the dependency graph comes from scripts/depgraph (which itself reuses the layering gate's edge
// model), the R6/R9 ratchet values come from scripts/layering/check.ts, fallow counts come from
// the checked-in baselines, coverage/size come from the artifacts their own gates already write,
// the slow-test ratchet comes from the vitest reporter, and the bench/skillgym counts come from
// their case registries.
//
// Field names are the trend/delta contract consumed by the follow-up quality-delta comment
// (#1424): they must stay stable, and any change bumps SNAPSHOT_SCHEMA_VERSION so a consumer
// refuses to diff across schema versions without a migration note.
//
// The component metrics (instability / abstractness / main-sequence distance) are OBSERVATORY
// DATA ONLY. They locate concrete, high-fan-in modules worth pinning harder; they must NEVER
// become CI thresholds (CONTEXT.md "Principles and their gates"). The single thing wired into CI
// is the depgraph-vs-layering R6 consistency assertion, which lives in the Layering Guard job.

import { TYPE_CYCLE_BASELINE, TYPE_INVERSION_BASELINE } from '../layering/check.ts';
import type { EdgeKind, GraphData } from '../depgraph/model.ts';
import {
  mainSequenceModules,
  zoneComponents,
  type MainSequenceModule,
  type ZoneComponent,
} from './components.ts';

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Total across a per-pair ratchet map, e.g. TYPE_INVERSION_BASELINE. */
export function ratchetTotal(byPair: Readonly<Record<string, number>>): number {
  return Object.values(byPair).reduce((sum, count) => sum + count, 0);
}

export type DepgraphMetrics = {
  files: number;
  edges: number;
  valueCycles: number;
  typeCycles: number;
  dynamicCycles: number;
  /** Value edges whose target is ALSO reachable at distance >= 2. Reachability, not removability. */
  redundantEdges: number;
  /** R5 ranked-spine back-edges over value edges (the gate keeps this at zero). */
  backEdges: number;
  /** R6 type-only spine-inversion edges, summed across zone pairs. */
  typeInversionEdges: number;
};

export function depgraphMetrics(graph: GraphData): DepgraphMetrics {
  const cyclesByKind = (kind: EdgeKind): number =>
    graph.cycles.filter((cycle) => cycle.kind === kind).length;
  return {
    files: graph.nodes.length,
    edges: graph.edges.length,
    valueCycles: cyclesByKind('value'),
    typeCycles: cyclesByKind('type'),
    dynamicCycles: cyclesByKind('dynamic'),
    redundantEdges: graph.edges.filter((edge) => edge.transitivelyReachable).length,
    backEdges: graph.edges.filter((edge) => edge.backEdge !== null).length,
    typeInversionEdges: ratchetTotal(graph.typeInversions),
  };
}

export type LayeringRatchets = {
  /** R6 baseline, per zone pair, and its total. The counts may only shrink (gate authority). */
  typeInversionBaseline: Readonly<Record<string, number>>;
  typeInversionTotal: number;
  /** R9 largest-type-cycle ceiling (growth-only ratchet). */
  typeCycleBaseline: number;
};

export function layeringRatchets(): LayeringRatchets {
  return {
    typeInversionBaseline: TYPE_INVERSION_BASELINE,
    typeInversionTotal: ratchetTotal(TYPE_INVERSION_BASELINE),
    typeCycleBaseline: TYPE_CYCLE_BASELINE,
  };
}

/**
 * The depgraph-vs-layering R6 cross-check (#1410): the graph the report builds over the real tree
 * must reproduce the gate's TYPE_INVERSION_BASELINE, pair for pair. `pnpm repo-health` fails when
 * this is false, and the identical assertion is wired into the Layering Guard CI job via
 * scripts/depgraph/model.test.ts. The gate stays the authority; a mismatch means the tree or the
 * baseline changed, never this check.
 */
export type R6Consistency = {
  ok: boolean;
  expected: Readonly<Record<string, number>>;
  actual: Readonly<Record<string, number>>;
};

function sortedEntries(byPair: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(byPair).sort(([left], [right]) => left.localeCompare(right));
}

export function r6Consistency(
  graphTypeInversions: Readonly<Record<string, number>>,
): R6Consistency {
  const expected = Object.fromEntries(sortedEntries(TYPE_INVERSION_BASELINE));
  const actual = Object.fromEntries(sortedEntries(graphTypeInversions));
  return {
    ok: JSON.stringify(actual) === JSON.stringify(expected),
    expected,
    actual,
  };
}

// ---- Fallow -----------------------------------------------------------------------------------

/** The fallow dead-code baseline: arrays of findings keyed by category. */
export type FallowDeadCodeBaseline = Record<string, unknown[]>;
/** The fallow health baseline: per-file maps of finding kind -> { count }. */
export type FallowHealthBaseline = {
  finding_counts?: Record<string, Record<string, { count: number }>>;
};
export type FallowConfig = {
  ignoreExports?: { exports: string[] }[];
  ignoreDependencies?: string[];
};

export type FallowMetrics = {
  /** Total dead-code findings recorded in the dead-code baseline. */
  deadCodeFindings: number;
  /** Total complexity/health findings recorded in the health baseline. */
  healthFindings: number;
  suppressions: {
    /** Distinct export entries suppressed via `ignoreExports` in .fallowrc.json. */
    ignoredExports: number;
    ignoredDependencies: number;
    total: number;
  };
};

export function fallowMetrics(
  deadCode: FallowDeadCodeBaseline,
  health: FallowHealthBaseline,
  config: FallowConfig,
): FallowMetrics {
  const deadCodeFindings = Object.values(deadCode).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0,
  );
  let healthFindings = 0;
  for (const perKind of Object.values(health.finding_counts ?? {})) {
    for (const finding of Object.values(perKind)) healthFindings += finding.count;
  }
  const ignoredExports = (config.ignoreExports ?? []).reduce(
    (sum, entry) => sum + (entry.exports?.length ?? 0),
    0,
  );
  const ignoredDependencies = (config.ignoreDependencies ?? []).length;
  return {
    deadCodeFindings,
    healthFindings,
    suppressions: {
      ignoredExports,
      ignoredDependencies,
      total: ignoredExports + ignoredDependencies,
    },
  };
}

// ---- Coverage & size (read from the artifacts their own gates already produce) ----------------

type CoverageTotalEntry = { total: number; covered: number; pct: number };
export type CoverageSummary = {
  total?: Record<'lines' | 'statements' | 'functions' | 'branches', CoverageTotalEntry>;
};
export type CoverageMetrics = {
  available: boolean;
  lines?: CoverageTotalEntry;
  statements?: CoverageTotalEntry;
  functions?: CoverageTotalEntry;
  branches?: CoverageTotalEntry;
};

export function coverageMetrics(summary: CoverageSummary | null): CoverageMetrics {
  if (!summary?.total) return { available: false };
  const { lines, statements, functions, branches } = summary.total;
  return { available: true, lines, statements, functions, branches };
}

export type SizeReport = {
  js?: { rawBytes: number; gzipBytes: number };
  npmPack?: { tarballBytes: number; unpackedBytes: number };
};
export type SizeMetrics = {
  available: boolean;
  jsRawBytes?: number;
  jsGzipBytes?: number;
  npmTarballBytes?: number;
  npmUnpackedBytes?: number;
};

export function sizeMetrics(report: SizeReport | null): SizeMetrics {
  if (!report?.js || !report.npmPack) return { available: false };
  return {
    available: true,
    jsRawBytes: report.js.rawBytes,
    jsGzipBytes: report.js.gzipBytes,
    npmTarballBytes: report.npmPack.tarballBytes,
    npmUnpackedBytes: report.npmPack.unpackedBytes,
  };
}

// ---- Slow-test / bench / skillgym (registry-derived counts) -----------------------------------

export type SlowTestRatchet = {
  unitBudgetMs: number;
  integrationBudgetMs: number;
  enforceFactor: number;
};

export type BenchMetrics = {
  /** Help-conformance bench cases (scripts/help-conformance-cases.mjs). */
  cases: number;
  /** Distinct help topics the cases exercise. */
  topics: number;
};

export function benchMetrics(cases: readonly { docs: readonly string[] }[]): BenchMetrics {
  return {
    cases: cases.length,
    topics: new Set(cases.flatMap((testCase) => testCase.docs)).size,
  };
}

// ---- Provenance -------------------------------------------------------------------------------

/**
 * Provenance for an analyzer artifact this snapshot READ but did not itself produce (coverage,
 * size). These artifacts carry no producing-commit stamp, so the snapshot cannot claim they match
 * `commit`. We instead record their content hash — so #1424 keys history on the bytes the metrics
 * came from, not on a commit they may predate — the `producerInputs` freshness was judged against,
 * and an explicit `stale` flag. Freshness is bound to the artifact's WHOLE producer input set, not
 * just `src` (coverage also depends on tests/config; size on package.json and packaging config), so
 * a change to any of them re-flags the artifact. A consumer must treat stale metrics as lagging
 * `commit`, never as current.
 */
export type ArtifactProvenance = {
  path: string;
  sha256: string;
  /** The producer input pathspecs whose freshness this verdict was computed against. */
  producerInputs: string[];
  stale: boolean;
};

/**
 * Whether an artifact predates any of its producer inputs. mtime is a local, offline signal (these
 * artifacts are git-ignored, so there is no blob to diff), evaluated against a single tree in one
 * run. Freshness we cannot prove is reported as stale: an EMPTY input set (nothing observable) and
 * any input newer than the artifact both mean the metrics may lag the tree — we never claim fresh
 * on the strength of `src` alone, which was the earlier false-negative.
 */
export function isArtifactStale(
  artifactMtimeMs: number,
  producerInputMtimesMs: readonly number[],
): boolean {
  return producerInputMtimesMs.length === 0 || Math.max(...producerInputMtimesMs) > artifactMtimeMs;
}

/** Bind an artifact to the bytes and the full producer input set its freshness was judged against. */
export function artifactProvenance(params: {
  path: string;
  sha256: string;
  producerInputs: string[];
  artifactMtimeMs: number;
  producerInputMtimesMs: readonly number[];
}): ArtifactProvenance {
  return {
    path: params.path,
    sha256: params.sha256,
    producerInputs: params.producerInputs,
    stale: isArtifactStale(params.artifactMtimeMs, params.producerInputMtimesMs),
  };
}

/**
 * What produced the snapshot and from which inputs. Mandatory in v1 (issue #1423 amendment) so
 * #1424 can persist history and refuse to diff across schema versions. `tool` holds a content
 * hash per analyzer (its own source/config, standing in for a version); `inputs` records the
 * lockfile and the read-only artifacts each family of metrics was computed from, each hashed and
 * flagged for staleness so a false commit-indexed history entry cannot slip through.
 */
export type Provenance = {
  schemaVersion: number;
  commit: string;
  ref: string | null;
  node: string;
  generatedAt: string;
  tool: Record<string, string>;
  inputs: {
    /** Production source files fed to the graph build. */
    sourceFiles: number;
    lockfile: { path: string; sha256: string } | null;
    /** Read artifacts, hashed and stale-flagged; null when absent (coverage/size degrade cleanly). */
    coverageSummary: ArtifactProvenance | null;
    sizeReport: ArtifactProvenance | null;
  };
};

// ---- Full snapshot ----------------------------------------------------------------------------

export type RepoHealthSnapshot = {
  schemaVersion: number;
  provenance: Provenance;
  /**
   * Component metrics are observatory data — they locate concrete high-fan-in modules and must
   * NEVER become CI thresholds. Only `consistency.r6` gates anything.
   */
  metrics: {
    depgraph: DepgraphMetrics;
    layering: LayeringRatchets;
    coverage: CoverageMetrics;
    size: SizeMetrics;
    fallow: FallowMetrics;
    slowTest: SlowTestRatchet;
    bench: BenchMetrics;
    skillgym: { cases: number };
    components: { byZone: ZoneComponent[] };
    mainSequence: { concreteHighFanIn: MainSequenceModule[] };
  };
  consistency: { r6: R6Consistency };
};

export type SnapshotInputs = {
  provenance: Provenance;
  graph: GraphData;
  fallow: { deadCode: FallowDeadCodeBaseline; health: FallowHealthBaseline; config: FallowConfig };
  coverage: CoverageSummary | null;
  size: SizeReport | null;
  slowTest: SlowTestRatchet;
  benchCases: readonly { docs: readonly string[] }[];
  skillgymCaseCount: number;
};

export function buildSnapshot(inputs: SnapshotInputs): RepoHealthSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    provenance: inputs.provenance,
    metrics: {
      depgraph: depgraphMetrics(inputs.graph),
      layering: layeringRatchets(),
      coverage: coverageMetrics(inputs.coverage),
      size: sizeMetrics(inputs.size),
      fallow: fallowMetrics(inputs.fallow.deadCode, inputs.fallow.health, inputs.fallow.config),
      slowTest: inputs.slowTest,
      bench: benchMetrics(inputs.benchCases),
      skillgym: { cases: inputs.skillgymCaseCount },
      components: { byZone: zoneComponents(inputs.graph) },
      mainSequence: { concreteHighFanIn: mainSequenceModules(inputs.graph) },
    },
    consistency: { r6: r6Consistency(inputs.graph.typeInversions) },
  };
}
