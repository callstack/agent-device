import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { listSourceFiles, TYPE_INVERSION_BASELINE } from '../layering/check.ts';
import { resolveImportEdges } from '../layering/model.ts';
import { buildGraph, type GraphData } from '../depgraph/model.ts';
import { mainSequenceModules, zoneComponents } from './components.ts';
import {
  collectArtifactProvenance,
  benchMetrics,
  buildSnapshot,
  coverageMetrics,
  depgraphMetrics,
  fallowMetrics,
  layeringRatchets,
  r6Consistency,
  ratchetTotal,
  sizeMetrics,
  SNAPSHOT_SCHEMA_VERSION,
  type Provenance,
} from './model.ts';

/** Build the report's graph over the real production tree, the way the command does. */
function realGraph(): GraphData {
  const files = listSourceFiles();
  const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  return buildGraph(sources, resolveImportEdges(sources));
}

/**
 * A tiny hand-made graph: two zones depend on kernel for VALUES and one for TYPES, so kernel is
 * concrete (abstractness 1/3) with fan-in 3 — a miniature of the real exec.ts/ref-frame.ts shape.
 */
function fixtureGraph(): GraphData {
  const sources = new Map([
    ['src/kernel/errors.ts', 'export const fail = 1;\nexport type Err = string;\n'],
    ['src/core/run.ts', "import { fail } from '../kernel/errors.ts';\nexport const run = 1;\n"],
    ['src/core/wrap.ts', "import { fail } from '../kernel/errors.ts';\nexport const wrap = 1;\n"],
    [
      'src/commands/tap.ts',
      [
        "import { run } from '../core/run.ts';",
        "import type { Err } from '../kernel/errors.ts';",
      ].join('\n'),
    ],
  ]);
  return buildGraph(sources, resolveImportEdges(sources));
}

test('depgraphMetrics reuses the graph rather than recomputing any number', () => {
  const metrics = depgraphMetrics(fixtureGraph());
  expect(metrics.files).toBe(4);
  expect(metrics.edges).toBe(4);
  expect(metrics.valueCycles).toBe(0);
  // commands -> kernel is a type-only import; the ranked spine outranks kernel so it is an R6
  // inversion, not a value/back edge.
  expect(metrics.backEdges).toBe(0);
});

test('ratchetTotal sums a per-pair ratchet map', () => {
  expect(ratchetTotal({ a: 3, b: 1, c: 2 })).toBe(6);
});

test('layeringRatchets reports the gate ratchets without re-deriving them', () => {
  const ratchets = layeringRatchets();
  expect(ratchets.typeInversionBaseline).toBe(TYPE_INVERSION_BASELINE);
  expect(ratchets.typeInversionTotal).toBe(ratchetTotal(TYPE_INVERSION_BASELINE));
  expect(ratchets.typeCycleBaseline).toBeGreaterThan(0);
});

describe('component metrics are derived from fan-in/fan-out', () => {
  test('zoneComponents computes instability, abstractness and main-sequence distance', () => {
    const byZone = zoneComponents(fixtureGraph());
    const kernel = byZone.find((zone) => zone.zone === 'kernel')!;
    // Nothing in the fixture leaves kernel, and three files depend on it (one type-only).
    expect(kernel.efferent).toBe(0);
    expect(kernel.afferent).toBe(3);
    expect(kernel.instability).toBe(0);
    expect(kernel.abstractness).toBe(0.333);
  });

  test('mainSequenceModules surfaces concrete high-fan-in modules only', () => {
    const modules = mainSequenceModules(fixtureGraph(), { minFanIn: 1 });
    const kernel = modules.find((module) => module.file === 'kernel/errors.ts')!;
    expect(kernel.fanIn).toBe(3);
    // Most dependents import it for values, so abstractness is 1/3 and it is concrete.
    expect(kernel.abstractness).toBe(0.333);
    expect(kernel.concrete).toBe(true);
  });
});

test('r6Consistency passes when the graph reproduces the baseline and fails on drift', () => {
  const passing = r6Consistency(TYPE_INVERSION_BASELINE);
  expect(passing.ok).toBe(true);

  const drifted = r6Consistency({ ...TYPE_INVERSION_BASELINE, 'commands -> client': 99 });
  expect(drifted.ok).toBe(false);
  expect(drifted.expected).toEqual(passing.expected);
});

test('fallowMetrics counts findings from the baselines and suppressions from the config', () => {
  const metrics = fallowMetrics(
    { unused_exports: [{}, {}], circular_dependencies: [], unused_files: [{}] },
    {
      finding_counts: {
        'src/a.ts': { complexity_critical: { count: 1 }, crap_moderate: { count: 2 } },
        'src/b.ts': { crap_moderate: { count: 1 } },
      },
    },
    {
      ignoreExports: [{ exports: ['x', 'y'] }, { exports: ['z'] }],
      ignoreDependencies: ['@theme'],
    },
  );
  expect(metrics.deadCodeFindings).toBe(3);
  expect(metrics.healthFindings).toBe(4);
  expect(metrics.suppressions).toEqual({ ignoredExports: 3, ignoredDependencies: 1, total: 4 });
});

test('coverage and size degrade to unavailable when the artifact is absent', () => {
  expect(coverageMetrics(null)).toEqual({ available: false });
  expect(sizeMetrics(null)).toEqual({ available: false });
  expect(
    coverageMetrics({ total: { lines: { total: 10, covered: 8, pct: 80 } } as never }).available,
  ).toBe(true);
});

// Drives the real collector (parse → read stamped commit → hash → status), so removing the
// commit-verification breaks these — unlike a fabricated status. Freshness is proven ONLY from a
// commit the artifact stamps, never mtime or a producer-input list.
test('collectArtifactProvenance proves freshness only from a commit the artifact stamps', () => {
  const path = 'coverage/coverage-summary.json';

  // A real coverage-summary shape stamps no commit — we cannot prove it matches HEAD, so `unknown`.
  const coverageShaped = JSON.stringify({ total: { lines: { total: 10, covered: 8, pct: 80 } } });
  const unknown = collectArtifactProvenance(path, coverageShaped, 'abc123');
  expect(unknown?.status).toBe('unknown');
  expect(unknown?.producerCommit).toBeNull();
  expect(unknown?.sha256).toMatch(/^[0-9a-f]{12}$/); // bytes still hashed for #1424

  // An artifact that stamps the current commit is proven current.
  expect(
    collectArtifactProvenance(path, JSON.stringify({ commit: 'abc123', total: {} }), 'abc123')
      ?.status,
  ).toBe('fresh');

  // A stamped commit that differs is stale — metrics predate HEAD.
  const stale = collectArtifactProvenance(path, JSON.stringify({ commit: 'old999' }), 'abc123');
  expect(stale?.status).toBe('stale');
  expect(stale?.producerCommit).toBe('old999');

  // Absent artifact degrades cleanly to null (coverage/size become { available: false }).
  expect(collectArtifactProvenance(path, null, 'abc123')).toBeNull();
});

test('benchMetrics counts cases and distinct topics from the case registry', () => {
  expect(benchMetrics([{ docs: ['a', 'b'] }, { docs: ['b'] }, { docs: ['c'] }])).toEqual({
    cases: 3,
    topics: 3,
  });
});

const PROVENANCE: Provenance = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  commit: 'abc',
  ref: 'main',
  node: 'v22',
  generatedAt: '2026-07-28T00:00:00.000Z',
  tool: {},
  inputs: { sourceFiles: 3, lockfile: null, coverageSummary: null, sizeReport: null },
};

test('buildSnapshot assembles every metric family and pins the schema version', () => {
  const snapshot = buildSnapshot({
    provenance: PROVENANCE,
    graph: fixtureGraph(),
    fallow: { deadCode: {}, health: {}, config: {} },
    coverage: null,
    size: null,
    slowTest: { unitBudgetMs: 2500, integrationBudgetMs: 15000, enforceFactor: 2 },
    benchCases: [{ docs: ['a'] }],
    skillgymCaseCount: 5,
  });
  expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
  expect(Object.keys(snapshot.metrics).sort()).toEqual([
    'bench',
    'components',
    'coverage',
    'depgraph',
    'fallow',
    'layering',
    'mainSequence',
    'size',
    'skillgym',
    'slowTest',
  ]);
  expect(snapshot.metrics.skillgym.cases).toBe(5);
});

// The acceptance spot-check (issue #1423): the main-sequence report must locate the concrete,
// high-fan-in foundations. src/utils/exec.ts (the process-exec seam) and src/daemon/ref-frame.ts
// both have many value dependents, so both must appear as concrete. Guards the metric against a
// sign flip or an abstractness inversion that would make the report point at the wrong modules.
test('the real-tree main-sequence report surfaces exec.ts and ref-frame.ts as concrete', () => {
  const graph = realGraph();
  const concrete = new Map(mainSequenceModules(graph).map((module) => [module.file, module]));
  for (const file of ['utils/exec.ts', 'daemon/ref-frame.ts']) {
    const module = concrete.get(file);
    expect(module, `${file} should surface as a concrete high-fan-in module`).toBeDefined();
    expect(module!.concrete).toBe(true);
    expect(module!.fanIn).toBeGreaterThanOrEqual(10);
  }

  // And the graph the report builds must reproduce the gate's R6 baseline over the real tree.
  expect(r6Consistency(graph.typeInversions).ok).toBe(true);
});
