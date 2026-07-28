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

import { createHash } from 'node:crypto';
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
 * Freshness of a READ artifact relative to the snapshot's `commit`. `fresh` requires proof; anything
 * unproven is `unknown`, never silently trusted.
 */
export type ArtifactStatus = 'fresh' | 'stale' | 'unknown';

/**
 * Provenance for an analyzer artifact this snapshot READ but did not itself produce (coverage,
 * size). Its freshness relative to `commit` is proven ONLY from a producing commit the artifact
 * stamps in its own bytes. We deliberately reject the two signals that cannot prove it: mtime (a
 * copy, restore, or CI cache download resets it) and an enumerated producer-input list (never
 * provably complete — the last review showed it silently omitted inputs). So a stamped commit equal
 * to `commit` is `fresh`; a different stamped commit is `stale`; NO stamp is `unknown`. Today
 * neither producer stamps a commit, so both report `unknown` — honest, since we cannot prove they
 * match; if a producer starts emitting one, it is verified automatically. `sha256` still records the
 * bytes so #1424 keys history on the exact metrics read. A consumer must treat `stale` and `unknown`
 * alike as not-current, never as `commit`.
 */
export type ArtifactProvenance = {
  path: string;
  sha256: string;
  /** The producing commit read from the artifact's own bytes, or null when it stamps none. */
  producerCommit: string | null;
  status: ArtifactStatus;
};

/** The producing commit an artifact stamps in its own JSON, if any (`producerCommit` or `commit`). */
function readStampedCommit(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ['producerCommit', 'commit']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * The whole read-artifact collector: hash the bytes, read any producing commit the artifact stamps,
 * and derive freshness against `currentCommit`. Returns null when the artifact is absent. This is
 * the function the runner wires to disk, so a test that drives it with real artifact bytes exercises
 * the actual freshness path end-to-end (not a fabricated status).
 */
export function collectArtifactProvenance(
  path: string,
  raw: string | null,
  currentCommit: string,
): ArtifactProvenance | null {
  if (raw === null) return null;
  const producerCommit = readStampedCommit(raw);
  const status: ArtifactStatus =
    producerCommit === null ? 'unknown' : producerCommit === currentCommit ? 'fresh' : 'stale';
  return {
    path,
    sha256: createHash('sha256').update(raw).digest('hex').slice(0, 12),
    producerCommit,
    status,
  };
}

/**
 * What produced the snapshot and from which inputs. Mandatory in v1 (issue #1423 amendment) so
 * #1424 can persist history and refuse to diff across schema versions. `tool` holds a content
 * hash per analyzer (its own source/config, standing in for a version); `inputs` records the
 * lockfile and the read-only artifacts each family of metrics was computed from, each hashed and
 * given a proven freshness `status` so a false commit-indexed history entry cannot slip through.
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
    /** Read artifacts, hashed with a proven freshness status; null when absent (degrade cleanly). */
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
