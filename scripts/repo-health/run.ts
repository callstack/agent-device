// Repo-health snapshot command (issue #1423, Track C of #1412):
//
//   pnpm repo-health            # human-readable summary
//   pnpm repo-health --json     # the raw JSON snapshot on stdout
//   pnpm repo-health --out p    # also write the JSON snapshot to a file
//
// One JSON snapshot aggregating the signals this repo already computes, by REUSING each analyzer
// rather than reimplementing any metric (see model.ts for which analyzer owns each number). It is
// DATA for agents to query, not a dashboard: no rendering, no history (that is #1424), and the
// component metrics are observatory-only and must never gate.
//
// It runs from a clean checkout in well under two minutes with no network: everything is read
// from the working tree, git, and the artifacts other gates already write. Coverage and package
// size are read from coverage/coverage-summary.json and .tmp/size-report.json when present and
// degrade to `available: false` (with the producing command) when they are not, so a fresh
// checkout still produces a complete, honest snapshot. Those two artifacts carry no producing-commit
// stamp, so provenance hashes them and flags `stale` when any of their producer inputs is newer
// (PRODUCER_INPUTS below; see artifactProvenance in model.ts) — coverage tracks tests + config, size
// tracks package.json + packaging config, not just `src`. A consumer like #1424 must never pair
// stale metrics with the current commit.
//
// The one thing that can FAIL the command is the depgraph-vs-layering R6 consistency assertion:
// the graph built here must reproduce scripts/layering/check.ts's TYPE_INVERSION_BASELINE. The
// identical assertion is wired into CI by the Layering Guard job (scripts/depgraph/model.test.ts).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listSourceFiles } from '../layering/check.ts';
import { resolveImportEdges } from '../layering/model.ts';
import { buildGraph, type GraphData } from '../depgraph/model.ts';
import { SLOW_TEST_RATCHET } from '../vitest-slow-test-budgets.ts';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runAsMain } from '../lib/run-as-main.ts';
import { CASES } from '../help-conformance-cases.mjs';
import skillgymSuite from '../../test/skillgym/suites/agent-device-smoke-suite.ts';
import {
  artifactProvenance,
  buildSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  type ArtifactProvenance,
  type FallowConfig,
  type FallowDeadCodeBaseline,
  type FallowHealthBaseline,
  type Provenance,
  type RepoHealthSnapshot,
} from './model.ts';

const USAGE = 'Usage: pnpm repo-health [--json] [--out <path>]\n';

const COVERAGE_SUMMARY_PATH = 'coverage/coverage-summary.json';
const SIZE_REPORT_PATH = '.tmp/size-report.json';
const LOCKFILE_PATH = 'pnpm-lock.yaml';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function readIfExists(relativePath: string): string | null {
  const abs = absolute(relativePath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function readJsonIfExists<T>(relativePath: string): T | null {
  const raw = readIfExists(relativePath);
  return raw === null ? null : (JSON.parse(raw) as T);
}

function shortSha(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/** Short content hash standing in for an analyzer's version — a source change is a version bump. */
function contentHash(relativePath: string): string {
  const raw = readIfExists(relativePath);
  return raw === null ? 'absent' : shortSha(raw);
}

function lockfileProvenance(): { path: string; sha256: string } | null {
  const raw = readIfExists(LOCKFILE_PATH);
  return raw === null ? null : { path: LOCKFILE_PATH, sha256: shortSha(raw) };
}

// The tracked inputs whose change can invalidate each READ artifact — NOT just `src`. Coverage is
// the whole test run (sources + tests + vitest config + the scripts package.json wires); size runs
// tsdown + `npm pack`, so packaging metadata and bundler/ts config are inputs. An old artifact is
// flagged stale when ANY of these is newer than it, closing the src-only false-negative.
const PRODUCER_INPUTS = {
  coverage: [
    'src/*.ts',
    'src/**/*.ts',
    'test',
    'vitest.config.ts',
    'vitest.*.config.ts',
    'package.json',
  ],
  size: [
    'src/*.ts',
    'src/**/*.ts',
    'package.json',
    'pnpm-lock.yaml',
    'tsdown.config.ts',
    'tsconfig.json',
    'tsconfig.lib.json',
    'scripts/size-report.mjs',
  ],
} as const;

/** Tracked files matching the pathspecs (offline, ignores untracked/generated); [] on failure. */
function trackedFiles(pathspecs: readonly string[]): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function mtimesMs(files: readonly string[]): number[] {
  const out: number[] = [];
  for (const file of files) {
    const abs = absolute(file);
    if (fs.existsSync(abs)) out.push(fs.statSync(abs).mtimeMs);
  }
  return out;
}

/** Hash a read artifact and judge freshness against its whole producer input set; null when absent. */
function artifactInput(
  relativePath: string,
  producerInputs: readonly string[],
): ArtifactProvenance | null {
  const abs = absolute(relativePath);
  if (!fs.existsSync(abs)) return null;
  return artifactProvenance({
    path: relativePath,
    sha256: shortSha(fs.readFileSync(abs, 'utf8')),
    producerInputs: [...producerInputs],
    artifactMtimeMs: fs.statSync(abs).mtimeMs,
    producerInputMtimesMs: mtimesMs(trackedFiles(producerInputs)),
  });
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function buildGraphFromTree(files: readonly string[]): GraphData {
  const sources = new Map(files.map((file) => [file, fs.readFileSync(absolute(file), 'utf8')]));
  return buildGraph(sources, resolveImportEdges(sources));
}

function currentCommit(): string {
  return gitOutput(['rev-parse', 'HEAD']) ?? 'unknown';
}

function currentRef(): string | null {
  return process.env.GITHUB_REF_NAME ?? gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']);
}

// A content hash per analyzer, standing in for a version: a change to the analyzer's own source
// is a version bump the snapshot records without a real semver to point at.
function toolHashes(): Record<string, string> {
  return {
    depgraph: contentHash('scripts/depgraph/model.ts'),
    layering: contentHash('scripts/layering/check.ts'),
    fallow: contentHash('.fallowrc.json'),
    coverage: contentHash('vitest.config.ts'),
    size: contentHash('scripts/size-report.mjs'),
    slowTest: contentHash('scripts/vitest-slow-test-budgets.ts'),
    bench: contentHash('scripts/help-conformance-cases.mjs'),
    skillgym: contentHash('test/skillgym/suites/agent-device-smoke-suite.ts'),
  };
}

function collectProvenance(
  graph: GraphData,
  coverage: ArtifactProvenance | null,
  size: ArtifactProvenance | null,
): Provenance {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    commit: currentCommit(),
    ref: currentRef(),
    node: process.version,
    generatedAt: new Date().toISOString(),
    tool: toolHashes(),
    inputs: {
      sourceFiles: graph.nodes.length,
      lockfile: lockfileProvenance(),
      coverageSummary: coverage,
      sizeReport: size,
    },
  };
}

function collectSnapshot(): RepoHealthSnapshot {
  const graph = buildGraphFromTree(listSourceFiles());
  const coverage = readJsonIfExists<import('./model.ts').CoverageSummary>(COVERAGE_SUMMARY_PATH);
  const size = readJsonIfExists<import('./model.ts').SizeReport>(SIZE_REPORT_PATH);
  return buildSnapshot({
    provenance: collectProvenance(
      graph,
      artifactInput(COVERAGE_SUMMARY_PATH, PRODUCER_INPUTS.coverage),
      artifactInput(SIZE_REPORT_PATH, PRODUCER_INPUTS.size),
    ),
    graph,
    fallow: {
      deadCode: readJsonIfExists<FallowDeadCodeBaseline>('fallow-baselines/dead-code.json') ?? {},
      health: readJsonIfExists<FallowHealthBaseline>('fallow-baselines/health.json') ?? {},
      config: readJsonIfExists<FallowConfig>('.fallowrc.json') ?? {},
    },
    coverage,
    size,
    slowTest: SLOW_TEST_RATCHET,
    benchCases: CASES,
    skillgymCaseCount: skillgymSuite.length,
  });
}

function pct(entry: { covered: number; total: number; pct: number } | undefined): string {
  return entry
    ? `${entry.pct.toFixed(2)}% (${entry.covered}/${entry.total})`
    : 'n/a (run pnpm test:coverage)';
}

function bytes(value: number | undefined): string {
  if (value === undefined) return 'n/a (run pnpm size:markdown)';
  if (value < 1000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)} kB`;
  return `${(value / 1_000_000).toFixed(2)} MB`;
}

function staleMark(artifact: ArtifactProvenance | null): string {
  return artifact?.stale ? ' [STALE — source newer than artifact; rerun the producer]' : '';
}

function renderSummary(snapshot: RepoHealthSnapshot): string {
  const { metrics, provenance, consistency } = snapshot;
  const lines: string[] = [
    `Repo health snapshot (schemaVersion ${snapshot.schemaVersion}) @ ${provenance.commit.slice(0, 12)}`,
    `  depgraph:  ${metrics.depgraph.files} files, ${metrics.depgraph.edges} edges, ` +
      `${metrics.depgraph.redundantEdges} redundant; cycles value=${metrics.depgraph.valueCycles} ` +
      `type=${metrics.depgraph.typeCycles} dynamic=${metrics.depgraph.dynamicCycles}`,
    `  layering:  R6 type-inversions=${metrics.layering.typeInversionTotal} ` +
      `(graph reproduces baseline: ${consistency.r6.ok ? 'yes' : 'NO'}); R9 type-cycle baseline=${metrics.layering.typeCycleBaseline}`,
    `  coverage:  lines ${pct(metrics.coverage.lines)}; statements ${pct(metrics.coverage.statements)}` +
      staleMark(provenance.inputs.coverageSummary),
    `  size:      js raw ${bytes(metrics.size.jsRawBytes)}, gzip ${bytes(metrics.size.jsGzipBytes)}; ` +
      `npm tarball ${bytes(metrics.size.npmTarballBytes)}` +
      staleMark(provenance.inputs.sizeReport),
    `  fallow:    dead-code findings=${metrics.fallow.deadCodeFindings}, health findings=${metrics.fallow.healthFindings}, ` +
      `suppressions=${metrics.fallow.suppressions.total}`,
    `  slow-test: unit ${metrics.slowTest.unitBudgetMs}ms / integration ${metrics.slowTest.integrationBudgetMs}ms (enforce ${metrics.slowTest.enforceFactor}x)`,
    `  bench:     ${metrics.bench.cases} cases across ${metrics.bench.topics} help topics; skillgym ${metrics.skillgym.cases} cases`,
    '',
    '  Component metrics (observatory only — never a CI threshold):',
    ...metrics.components.byZone
      .slice(0, 8)
      .map(
        (zone) =>
          `    ${zone.zone.padEnd(16)} Ca=${String(zone.afferent).padStart(4)} Ce=${String(zone.efferent).padStart(4)} ` +
          `I=${zone.instability.toFixed(2)} A=${zone.abstractness.toFixed(2)} D=${zone.distance.toFixed(2)}`,
      ),
    '  Concrete high-fan-in modules worth pinning harder:',
    ...metrics.mainSequence.concreteHighFanIn
      .slice(0, 8)
      .map(
        (module) =>
          `    ${module.file.padEnd(40)} fanIn=${String(module.fanIn).padStart(3)} A=${module.abstractness.toFixed(2)}`,
      ),
  ];
  return `${lines.join('\n')}\n`;
}

function run(argv: readonly string[]): number {
  const values = parseScriptArgs(argv, USAGE, {
    json: { type: 'boolean', default: false },
    out: { type: 'string' },
  });

  const snapshot = collectSnapshot();
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (typeof values.out === 'string') {
    const outPath = path.resolve(values.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized);
  }

  process.stdout.write(values.json ? serialized : renderSummary(snapshot));

  const { r6 } = snapshot.consistency;
  if (!r6.ok) {
    process.stderr.write(
      'repo-health: the dependency graph disagrees with the layering gate about R6 type-only ' +
        'spine inversions.\n' +
        `  gate baseline (TYPE_INVERSION_BASELINE): ${JSON.stringify(r6.expected)}\n` +
        `  graph over the current tree:             ${JSON.stringify(r6.actual)}\n` +
        'The gate is the authority — fix the inverting edge, or update TYPE_INVERSION_BASELINE in ' +
        'scripts/layering/check.ts. See scripts/depgraph/README.md.\n',
    );
    return 1;
  }
  return 0;
}

runAsMain(import.meta.url, 'repo-health', run);
