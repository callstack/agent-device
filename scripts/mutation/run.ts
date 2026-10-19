// Entrypoint for the decision-kernel mutation lane (issue #1415).
//
//   pnpm mutation:run                       full sweep, rendered as a report
//   pnpm mutation:check --report <file>     score an existing Stryker report
//   pnpm mutation:affected --base origin/main
//                                           PR lane: mutate only the kernel
//                                           modules the diff touches
//
// The lane reports and never gates (#1457): a score can only ever be printed,
// written to the job summary and uploaded as an artifact. The only non-zero exit
// is a harness failure — a missing report, an incomplete shard set, a bad
// argument — never a low score.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdStreaming, runCmdSync } from '@agent-device/host-kit/command';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { laneEnvelope } from '@agent-device/test-kit';
import { COVERAGE_CAPTURE_ENV } from './coverage-reporter.mjs';
import {
  assertCoveragePolicy,
  coverageScope,
  scopedTestFiles,
  scopeFingerprint,
  type CoverageScope,
  type ScopeIdentity,
} from './coverage-scope.ts';
import { mutationSeed, MUTATION_SEED_ENV } from './seed.ts';
import type { DryRunCompletedEvent } from '@stryker-mutator/api/report';
import {
  ALL_MODULE_IDS,
  isModuleId,
  LANE_CANARY,
  mutateGlobs,
  normalizePath,
  shardMatrix,
  type ModuleId,
  type ShardSpec,
} from './modules.ts';
import { shardFiles, type Shard } from './sharding.ts';
import { derivedAffectedModules } from './ownership.ts';
import { renderReport, type Provenance } from './report.ts';
import { mergeReports, summarizeReport, type ModuleScore, type StrykerReport } from './score.ts';
import {
  expandMutateFiles,
  relatedTestFiles,
  TEST_SCOPE_ENV,
  writeTestScope,
} from './test-scope.ts';

const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();

const CONFIG_PATH = 'stryker.config.json';
const DEFAULT_REPORT_PATH = '.tmp/mutation/mutation.json';
const TEST_SCOPE_PATH = '.tmp/mutation/test-scope.json';
const ENVELOPE_PATH = '.tmp/mutation/lane-envelope.json';
const LANE_ID = 'mutation-decision-kernels';
const COVERAGE_SCOPE_PATH = '.tmp/mutation/coverage-scope.json';
const COVERAGE_CAPTURE_PATH = '.tmp/mutation/coverage-capture.json';

const USAGE = `Usage: pnpm mutation:run [options]

  --modules <a,b>   Restrict to specific kernel modules (default: all)
  --seed <integer>  Fix fast-check inputs (0..2147483647)
  --scope-probe     Produce fresh coverage-scope.json for one entire module
  --scope-index <f> Narrow runtime tests using a matching coverage probe
  --scope-epoch <s> Invocation identifier; required with --seed for scope pilots
  --affected        Restrict to the modules touched between --base and HEAD
  --base <ref>      Base ref for --affected (default: origin/main)
  --report <file>   Read an existing Stryker JSON report instead of running Stryker
  --report-dir <d>  Merge every *.json Stryker report under <d> (weekly shards)
  --expect-shards <n>
                    Fail unless --report-dir holds exactly n shard reports
  --shard <i/n>     Mutate only the i-th of n balanced slices of the module's
                    sources (the big modules exceed one job's budget)
  --summary <file>  Also write the markdown report to <file>
  --no-run          Alias for --report with the default report path
  --list-affected   Print the PR lane's shard matrix as JSON and exit (empty
                    unless the diff touches the lane's own sources)
  --with-dependencies
                    Also select the canary for a diff touching only the lane's
                    dependency manifests
  --fail-envelope <reason>
                    Write a failed lane envelope for a step that ran before (or
                    instead of) the sweep, e.g. a self-test failure

Local coverage pilot (opt-in; weekly defaults remain broad):
  pnpm mutation:run --modules snapshot-occlusion --seed 12345 --scope-epoch run-1 --scope-probe
  pnpm mutation:run --modules snapshot-occlusion --seed 12345 --scope-epoch run-1 --scope-index .tmp/mutation/coverage-scope.json

Use a new epoch for each experiment and unchanged inputs in the same checkout/environment.
A whole-module probe can serve multiple sequential --shard consumers; save each report because
scope/report paths are shared. Consumers collect fresh coverage and execute mutants; results
are never reused. Missing, corrupt, changed or empty explicit indexes fail.

The index fingerprints tracked/nonignored contents, inventory, permissions, tools, Node/OS
and environment (values are hashed). pnpm launcher command text is removed before test execution.
--seed fixes fast-check defaults; explicit property seeds and other randomness remain independent.
Only fresh perTest/ignoreStatic=true runs support narrowing. Static audits require separate scope.
Subprocess/thread exclusions retain the existing lane policy. Different CI job environments
are not supported. Probe success measures coverage only, never mutant outcomes.

Before enabling CI defaults, compare fresh broad/scoped Ubuntu sweeps at one commit and seed:
identical mutant identities, no lost kills or extra uncovered mutants, explain outcome changes,
and measure both runner-minutes and critical-path time including the producer and transfers.
The first consumer can be slower; savings must amortize across consumers. Keep cross-run index
reuse and incremental results deferred. Repeat parity checks when scoping, static policy or tools change.
`;

type Args = {
  modules: readonly ModuleId[];
  affected: boolean;
  base: string;
  report: string | undefined;
  reportDir: string | undefined;
  summary: string | undefined;
  listAffected: boolean;
  withDependencies: boolean;
  failEnvelope: string | undefined;
  shard: Shard | undefined;
  expectShards: number | undefined;
  seed: number | undefined;
  scopeProbe: boolean;
  scopeIndex: string | undefined;
  scopeEpoch: string | undefined;
};

function parseShard(value: string | undefined): Shard | undefined {
  if (!value) return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index < 1 || index > count) {
    throw new Error(`--shard expects i/n with 1 <= i <= n, got "${value}"`);
  }
  return { index, count };
}

function parseModules(value: string | undefined): readonly ModuleId[] {
  if (!value) return ALL_MODULE_IDS;
  const ids = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !isModuleId(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown mutation module(s): ${unknown.join(', ')}. Known: ${ALL_MODULE_IDS.join(', ')}`,
    );
  }
  return ids.filter(isModuleId);
}

function parseMutationArgs(argv: readonly string[]): Args {
  const values = parseScriptArgs(argv, USAGE, {
    modules: { type: 'string' },
    affected: { type: 'boolean', default: false },
    base: { type: 'string', default: 'origin/main' },
    report: { type: 'string' },
    'report-dir': { type: 'string' },
    summary: { type: 'string' },
    'no-run': { type: 'boolean', default: false },
    'list-affected': { type: 'boolean', default: false },
    'with-dependencies': { type: 'boolean', default: false },
    'fail-envelope': { type: 'string' },
    shard: { type: 'string' },
    'expect-shards': { type: 'string' },
    seed: { type: 'string' },
    'scope-probe': { type: 'boolean', default: false },
    'scope-index': { type: 'string' },
    'scope-epoch': { type: 'string' },
  });
  const args: Args = {
    modules: parseModules(values.modules),
    affected: Boolean(values.affected),
    base: values.base ?? 'origin/main',
    report: values.report ?? (values['no-run'] ? DEFAULT_REPORT_PATH : undefined),
    reportDir: values['report-dir'],
    summary: values.summary,
    listAffected: Boolean(values['list-affected']),
    withDependencies: Boolean(values['with-dependencies']),
    failEnvelope: values['fail-envelope'],
    shard: parseShard(values.shard),
    expectShards: values['expect-shards'] ? Number(values['expect-shards']) : undefined,
    seed: mutationSeed(values.seed),
    scopeProbe: Boolean(values['scope-probe']),
    scopeIndex: values['scope-index'],
    scopeEpoch: values['scope-epoch'],
  };
  validateMutationArgs(args);
  return args;
}

function validateMutationArgs(args: Args): void {
  if (args.scopeProbe || args.scopeIndex !== undefined) {
    const incompatible = [
      args.affected,
      args.report,
      args.reportDir,
      args.listAffected,
      args.failEnvelope,
      args.expectShards !== undefined,
    ];
    if (
      args.modules.length !== 1 ||
      args.seed === undefined ||
      !args.scopeEpoch ||
      (!args.scopeIndex && !args.scopeProbe) ||
      incompatible.some(Boolean) ||
      (args.scopeProbe && (args.scopeIndex !== undefined || args.shard))
    )
      throw new Error(
        'Scope pilots require one module, --seed and --scope-epoch; probe cannot be sharded or consume an index, and pilots cannot read reports or select affected modules',
      );
  } else if (args.scopeEpoch !== undefined)
    throw new Error('--scope-epoch requires --scope-probe or --scope-index');
  if (args.seed !== undefined && (args.report || args.reportDir))
    throw new Error('--seed requires fresh execution, not an existing report');
}

/** Short, stable content hash of the Stryker config — half of a run's provenance. */
export function configHash(configText: string): string {
  return `sha256:${crypto.createHash('sha256').update(configText).digest('hex').slice(0, 12)}`;
}

function readProvenance(root: string = repoRoot): Provenance {
  const pkgPath = path.join(root, 'node_modules/@stryker-mutator/core/package.json');
  const version = fs.existsSync(pkgPath)
    ? (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version
    : 'unknown';
  return {
    strykerVersion: version,
    configHash: configHash(fs.readFileSync(path.join(root, CONFIG_PATH), 'utf8')),
  };
}

function changedFiles(base: string): string[] {
  const result = runCmdSync('git', ['diff', '--name-only', '--merge-base', base, 'HEAD'], {
    cwd: repoRoot,
    allowFailure: true,
  });
  return result.stdout.split('\n').filter(Boolean);
}

async function mutationTestScope(
  modules: readonly ModuleId[],
  sources: readonly string[],
  options: Args,
) {
  const pilot = options.scopeProbe || Boolean(options.scopeIndex);
  if (pilot)
    assertCoveragePolicy(JSON.parse(fs.readFileSync(path.join(repoRoot, CONFIG_PATH), 'utf8')));
  const index: CoverageScope | undefined = options.scopeIndex
    ? JSON.parse(fs.readFileSync(path.resolve(repoRoot, options.scopeIndex), 'utf8'))
    : undefined;
  const candidates = await relatedTestFiles(sources, repoRoot);
  const identity = pilot
    ? {
        module: modules[0]!,
        epoch: options.scopeEpoch!,
        seed: options.seed!,
        fingerprint: scopeFingerprint(repoRoot),
      }
    : undefined;
  const testFiles = options.scopeIndex
    ? scopedTestFiles(index!, identity!, candidates)
    : candidates;
  if (!testFiles.length) throw new Error(`No related mutation tests for ${modules.join(', ')}`);
  return { candidates, identity, index, testFiles };
}

async function mutationSourceScope(modules: readonly ModuleId[], shard: Shard | undefined) {
  const globs = mutateGlobs(modules);
  const all = expandMutateFiles(globs, repoRoot);
  if (!shard) return { mutate: globs, sources: all, sourceCount: all.length };
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, CONFIG_PATH), 'utf8'));
  const mutate = await shardFiles(all, shard, repoRoot, config.mutator?.excludedMutations ?? []);
  return {
    mutate,
    sources: [...new Set(mutate.map((file) => file.split(':')[0]!))],
    sourceCount: mutate.length,
  };
}

function finishScopeProbe(
  exitCode: number,
  capturePath: string,
  identity: ScopeIdentity,
  candidates: readonly string[],
  startedAt: number,
): ScopeMeasurement {
  if (exitCode !== 0 || !fs.existsSync(capturePath))
    throw new Error('Stryker scope probe failed or produced no coverage capture');
  if (scopeFingerprint(repoRoot) !== identity.fingerprint)
    throw new Error('Execution inputs changed during the scope probe');
  const scope = coverageScope(
    JSON.parse(fs.readFileSync(capturePath, 'utf8')) as DryRunCompletedEvent,
    identity,
    candidates,
    repoRoot,
    Date.now() - startedAt,
  );
  fs.writeFileSync(path.join(repoRoot, COVERAGE_SCOPE_PATH), `${JSON.stringify(scope, null, 2)}\n`);
  return {
    mode: 'probe',
    candidates: candidates.length,
    selected: scope.covered.length,
    producerMs: scope.producerMs,
  };
}

async function runStryker(
  modules: readonly ModuleId[],
  reportPath: string,
  shard: Shard | undefined,
  options: Args,
): Promise<ScopeMeasurement> {
  const startedAt = Date.now();
  // pnpm appends flags to this metadata; tests must see the same environment in
  // probes, broad references and scoped consumers.
  delete process.env.npm_lifecycle_script;
  const absolute = path.isAbsolute(reportPath) ? reportPath : path.join(repoRoot, reportPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.rmSync(absolute, { force: true });
  const capturePath = path.join(repoRoot, COVERAGE_CAPTURE_PATH);
  if (options.scopeProbe) {
    fs.rmSync(capturePath, { force: true });
    fs.rmSync(path.join(repoRoot, COVERAGE_SCOPE_PATH), { force: true });
  }
  // The suite Stryker replays per mutant is derived from Vitest's module graph
  // over the mutated files, not hand-listed; see scripts/mutation/test-scope.ts.
  const { mutate, sources, sourceCount } = await mutationSourceScope(modules, shard);
  const scopePath = path.join(repoRoot, TEST_SCOPE_PATH);
  const { candidates, identity, index, testFiles } = await mutationTestScope(
    modules,
    sources,
    options,
  );
  writeTestScope(testFiles, scopePath);
  process.stdout.write(
    `mutation: ${modules.join(', ')}${shard ? ` shard ${shard.index}/${shard.count}` : ''} -> ` +
      `${sourceCount} source(s), ${testFiles.length} related test file(s)\n`,
  );

  // Stryker's `--mutate` takes one comma-separated value, not repeated args.
  const args = ['exec', 'stryker', 'run', CONFIG_PATH, '--mutate', mutate.join(',')];
  if (options.scopeProbe) {
    args.push(
      '--dryRunOnly',
      '--appendPlugins',
      path.join(repoRoot, 'scripts/mutation/coverage-reporter.mjs'),
      '--reporters',
      'scope-coverage',
    );
  }
  const result = await runCmdStreaming('pnpm', args, {
    cwd: repoRoot,
    allowFailure: true,
    env: {
      ...process.env,
      [TEST_SCOPE_ENV]: scopePath,
      [MUTATION_SEED_ENV]: options.seed === undefined ? undefined : String(options.seed),
      [COVERAGE_CAPTURE_ENV]: options.scopeProbe ? capturePath : undefined,
    },
    onStdoutChunk: (chunk) => void process.stdout.write(chunk),
    onStderrChunk: (chunk) => void process.stderr.write(chunk),
  });
  if (options.scopeProbe) {
    return finishScopeProbe(result.exitCode, capturePath, identity!, candidates, startedAt);
  }
  // No score threshold is configured. Any non-zero exit is a harness failure,
  // even if Stryker wrote a partial report before failing.
  if (result.exitCode !== 0 || !fs.existsSync(absolute)) {
    throw new Error(
      `Stryker failed (exit ${result.exitCode}) or produced no report at ${reportPath}. See output above.`,
    );
  }
  if (identity && scopeFingerprint(repoRoot) !== identity.fingerprint)
    throw new Error('Execution inputs changed during the scoped mutation run');
  return {
    mode: index ? 'coverage' : 'related',
    candidates: candidates.length,
    selected: testFiles.length,
    producerMs: index?.producerMs ?? null,
  };
}

function emit(markdown: string, summaryPath: string | undefined): void {
  process.stdout.write(`\n${markdown}`);
  const targets = [summaryPath, process.env.GITHUB_STEP_SUMMARY].filter(
    (target): target is string => Boolean(target),
  );
  for (const target of targets) {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.appendFileSync(target, markdown);
  }
}

/**
 * How far the lane got. A run that dies in `stryker` or `report` is exactly the
 * failure the freshness monitor must see, so the stage rides in the envelope
 * rather than only in the job log.
 */
type Stage = 'setup' | 'select' | 'stryker' | 'report' | 'score' | 'complete';

/**
 * Provenance for a lane that died before it could read any: `unknown` is a
 * reported fact, whereas skipping the envelope would be silence.
 */
const UNKNOWN_PROVENANCE: Provenance = { strykerVersion: 'unknown', configHash: 'unknown' };
type ScopeMeasurement = {
  mode: 'probe' | 'coverage' | 'related';
  candidates: number;
  selected: number;
  producerMs: number | null;
};

type LaneState = {
  stage: Stage;
  provenance: Provenance;
  modules: readonly ModuleId[];
  affected: boolean;
  scores: readonly ModuleScore[];
  error: string | undefined;
  /**
   * `--fail-envelope` keeps an existing *failure* (its reason is the specific
   * one) but replaces an existing pass: a step can fail after the report was
   * rendered, and publishing that job as passing is the bug the envelope exists
   * to prevent.
   */
  recoveryOnly: boolean;
  seed?: number;
  scope?: ScopeMeasurement;
  pilotScope?: 'coverage-probe' | 'coverage-scoped';
};

/** The result of an envelope already on disk, if there is a readable one. */
function existingResult(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { result?: string }).result;
  } catch {
    return undefined;
  }
}

/**
 * A module's measurement for the envelope, or explicit nulls when the lane died
 * before measuring it — an absent field would read as "no mutants", a score.
 */
function envelopeModule(id: ModuleId, scores: readonly ModuleScore[]) {
  const score = scores.find((entry) => entry.module === id);
  if (!score) {
    return {
      id,
      score: null,
      killed: null,
      survived: null,
      total: null,
      timeout: null,
      noCoverage: null,
      errors: null,
    };
  }
  const { module: _module, surviving: _surviving, ...measured } = score;
  return { id, ...measured };
}

/**
 * Scheduled-lane artifact envelope (#1430). Without it a downloaded report cannot
 * say which commit or Stryker/config version produced it, how long the sweep took,
 * or whether it passed — freshness and tool-drift monitoring would have to parse
 * logs.
 *
 * Written on every exit path, including a crashed setup or a Stryker run that
 * produced no report: a lane that fails before it can measure anything is the
 * dark-lane case, and an absent envelope is indistinguishable from a lane that
 * never ran.
 */
function writeEnvelope(state: LaneState, startedAtMs: number): void {
  const target = path.join(repoRoot, ENVELOPE_PATH);
  if (state.recoveryOnly && existingResult(target) === 'fail') {
    process.stdout.write(`mutation: ${ENVELOPE_PATH} already reports a failure; left as is.\n`);
    return;
  }
  const envelope = laneEnvelope({
    lane: LANE_ID,
    commit: runCmdSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      allowFailure: true,
    }).stdout.trim(),
    tool: { stryker: state.provenance.strykerVersion },
    configHash: state.provenance.configHash,
    startedAtMs,
    seed: state.seed === undefined ? undefined : String(state.seed),
    // The lane never judges a score, so the result states whether the lane
    // produced a report at all.
    result: state.stage === 'complete' ? 'pass' : 'fail',
    data: {
      scope: state.pilotScope ?? (state.affected ? 'affected' : 'full-sweep'),
      testScope: state.scope ?? null,
      stage: state.stage,
      error: state.error ?? null,
      modules: state.modules.map((id) => envelopeModule(id, state.scores)),
    },
  });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(
    `\nLane envelope (${ENVELOPE_PATH}): ${envelope.result} at stage ${state.stage} in ` +
      `${Math.round(envelope.durationMs / 1000)}s at ${envelope.commit.slice(0, 12)}.\n`,
  );
}

function readReport(file: string): StrykerReport {
  const absolute = path.isAbsolute(file) ? file : path.join(repoRoot, file);
  return JSON.parse(fs.readFileSync(absolute, 'utf8')) as StrykerReport;
}

/**
 * Merges whatever shard reports are present and says how many there were. The
 * expected-count verdict is the caller's, so a short set is still scored and
 * published before it fails.
 */
function readShardedReports(dir: string): {
  report: StrykerReport;
  count: number;
  failed: string[];
} {
  const root = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
  // Shard artifacts also carry the lane envelope and the derived test scope, so
  // the report is selected by name rather than by "every .json here".
  const files = fs
    .globSync(`**/${path.basename(DEFAULT_REPORT_PATH)}`, { cwd: root })
    .map((file) => path.join(root, file))
    .sort();
  if (files.length === 0) throw new Error(`No Stryker JSON reports found under ${dir}`);
  process.stdout.write(`mutation: merging ${files.length} shard report(s) from ${dir}\n`);
  const shardDirectories = new Set([
    ...files.map((file) => path.dirname(file)),
    ...fs
      .globSync('**/lane-envelope.json', { cwd: root })
      .map((file) => path.dirname(path.join(root, file))),
  ]);
  const failed = [...shardDirectories]
    .filter(
      (directory) =>
        existingResult(path.join(directory, 'lane-envelope.json')) !== 'pass' ||
        !fs.existsSync(path.join(directory, path.basename(DEFAULT_REPORT_PATH))),
    )
    .map((directory) => path.basename(directory))
    .sort();
  return { report: mergeReports(files.map(readReport)), count: files.length, failed };
}

async function produceReport(
  modules: readonly ModuleId[],
  reportPath: string | undefined,
  shard: Shard | undefined,
  args: Args,
  state: LaneState,
): Promise<StrykerReport> {
  if (!reportPath) state.scope = await runStryker(modules, DEFAULT_REPORT_PATH, shard, args);
  return readReport(reportPath ?? DEFAULT_REPORT_PATH);
}

type ShardSummary = { count: number; failed: readonly string[] };

/** Every reported shard must pass; expected counts and module coverage also apply. */
function incompleteSweepReason(
  scores: readonly ModuleScore[],
  shards: ShardSummary,
  args: Args,
): string | undefined {
  if (args.expectShards !== undefined && shards.count !== args.expectShards) {
    return (
      `Incomplete shard set from ${args.reportDir}: ${shards.count} report(s), expected ${args.expectShards}. ` +
      'A shard job failed or its artifact is absent; the aggregate is not a sweep.'
    );
  }
  if (shards.failed.length > 0) {
    return `Shard failure or missing envelope: ${shards.failed.join(', ')}`;
  }
  const missing = scores.filter((score) => score.total === 0).map((score) => score.module);
  if (missing.length === 0) return undefined;
  return (
    `Incomplete shard set from ${args.reportDir}: no mutants for ${missing.join(', ')}. ` +
    'A shard job failed or its artifact is absent; the aggregate is not a sweep.'
  );
}

/**
 * Reads shard reports, an existing report, or runs Stryker — and scores them.
 * Returns the shard count when the source was a shard directory.
 */
async function scoreModules(args: Args, state: LaneState): Promise<ShardSummary | undefined> {
  state.stage = args.reportDir || args.report ? 'report' : 'stryker';
  const shards = args.reportDir ? readShardedReports(args.reportDir) : undefined;
  const report =
    shards?.report ?? (await produceReport(state.modules, args.report, args.shard, args, state));

  state.stage = 'score';
  state.scores = summarizeReport(report, state.modules);
  return shards;
}

async function sweep(args: Args, state: LaneState): Promise<number> {
  state.stage = 'select';
  // Same selection the PR matrix uses, so the reporting job can never score
  // mutants the `select` job decided not to spend.
  if (args.affected) {
    state.modules = [...new Set(affectedMatrix(args).map((entry) => entry.module))];
  }
  if (state.modules.length === 0) {
    process.stdout.write('mutation: no decision-kernel modules affected — nothing to mutate.\n');
    state.stage = 'complete';
    return 0;
  }

  if (args.scopeProbe) {
    state.stage = 'stryker';
    state.scope = await runStryker(state.modules, DEFAULT_REPORT_PATH, undefined, args);
    emit(
      `## Mutation coverage probe\n\n${state.scope.selected}/${state.scope.candidates} test files cover runtime mutants. Producer cost: ${state.scope.producerMs}ms. No mutants tested.\n`,
      args.summary,
    );
    state.stage = 'complete';
    return 0;
  }
  const shards = await scoreModules(args, state);

  const title = args.affected
    ? 'Mutation score — affected decision kernels'
    : 'Mutation score — decision kernels';
  const reason = shards ? incompleteSweepReason(state.scores, shards, args) : undefined;
  emit(renderReport(state.scores, state.provenance, { title, incomplete: reason }), args.summary);
  if (state.scope) {
    const producer =
      state.scope.producerMs === null
        ? ''
        : ` Probe cost: ${state.scope.producerMs}ms (charged separately).`;
    emit(
      `\nTest scope: ${state.scope.mode}; ${state.scope.selected}/${state.scope.candidates} files.${producer}\n`,
      args.summary,
    );
  }
  if (reason) throw new Error(reason);
  state.stage = 'complete';
  return 0;
}

/** Code and config the lane executes: a change here proves itself on real mutants on every PR. */
const LANE_SOURCES = [
  'scripts/mutation/',
  'scripts/lib/',
  'stryker.config.json',
  'vitest.mutation.config.ts',
  'vitest.config.ts',
  '.github/workflows/mutation-weekly.yml',
  '.github/workflows/mutation-affected.yml',
];

/**
 * Manifests the lane resolves through. Unrelated PRs touch these routinely (a
 * workspace export, a root script), so a diff confined to them spends mutants
 * only under `--with-dependencies`, which the workflow's manual dispatch passes.
 */
const LANE_DEPENDENCIES = ['package.json', 'pnpm-lock.yaml', 'packages/*/package.json'];

/**
 * `mutation-affected.yml` triggers on exactly these, asserted by
 * `workflow.test.ts`: sources spend the canary, and a dependency-only diff runs
 * the harness self-test. A filter that missed one would let that change merge
 * unproven.
 */
export const LANE_TOOLING = [...LANE_SOURCES, ...LANE_DEPENDENCIES];

/**
 * The PR lane's matrix: empty unless the diff touches the harness, otherwise the
 * canary plus whatever kernels that same diff derives. The kernel report that
 * pays is the weekly sweep, so the PR lane spends mutants on one thing only —
 * proving the harness still runs end to end when the harness changes. Selecting
 * on derived kernel ownership alone would run the full sweep on 24 of
 * the last 40 merged PRs, a per-PR full sweep for a report nobody gates on.
 */
export function affectedMatrixFor(
  changed: readonly string[],
  { withDependencies = false }: { withDependencies?: boolean } = {},
): ShardSpec[] {
  const lanePaths = withDependencies ? LANE_TOOLING : LANE_SOURCES;
  const touchesLane = changed.some((file) =>
    lanePaths.some((pattern) =>
      path.matchesGlob(normalizePath(file), pattern.endsWith('/') ? `${pattern}**` : pattern),
    ),
  );
  if (!touchesLane) return [];
  const modules = new Set(derivedAffectedModules(changed, repoRoot));
  // Lane sources own no kernel, so a tooling-only diff derives nothing: without
  // the canary the lane would select zero mutants and prove nothing.
  modules.add(LANE_CANARY);
  return shardMatrix(ALL_MODULE_IDS.filter((id) => modules.has(id)));
}

function affectedMatrix({ base, withDependencies }: Args): ShardSpec[] {
  return affectedMatrixFor(changedFiles(base), { withDependencies });
}

/**
 * Everything after `--help` runs inside the envelope boundary, argument parsing
 * and provenance reads included: a lane that cannot even read its own config is
 * the failure freshness monitoring most needs to see.
 */
async function run(argv: readonly string[], state: LaneState): Promise<number> {
  const args = parseMutationArgs(argv);
  state.affected = args.affected;
  state.provenance = readProvenance();
  state.modules = args.modules;
  state.seed = args.seed;
  state.pilotScope = args.scopeProbe
    ? 'coverage-probe'
    : args.scopeIndex
      ? 'coverage-scoped'
      : undefined;
  if (args.failEnvelope) {
    // A step that ran before the sweep failed (the weekly self-test, setup): the
    // lane produced no measurement, and that is what the envelope must say.
    state.error = args.failEnvelope;
    state.recoveryOnly = true;
    return 1;
  }
  return await sweep(args, state);
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const startedAtMs = Date.now();
  if (argv.includes('--list-affected')) {
    // Selection only — no lane run, so no envelope. The shard jobs that consume
    // this matrix each write their own.
    const args = parseMutationArgs(argv);
    process.stdout.write(`${JSON.stringify(affectedMatrix(args))}\n`);
    return 0;
  }
  const state: LaneState = {
    stage: 'setup',
    provenance: UNKNOWN_PROVENANCE,
    modules: [],
    affected: false,
    scores: [],
    error: undefined,
    recoveryOnly: false,
  };
  try {
    return await run(argv, state);
  } catch (error: unknown) {
    state.error = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mutation: ${state.error}\n`);
    return 1;
  } finally {
    writeEnvelope(state, startedAtMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`mutation: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
