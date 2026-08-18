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
import { runCmdStreaming, runCmdSync } from '../../src/utils/exec.ts';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { laneEnvelope } from '../lib/lane-envelope.ts';
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

const USAGE = `Usage: pnpm mutation:run [options]

  --modules <a,b>   Restrict to specific kernel modules (default: all)
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
                    unless the diff touches the lane's own tooling)
  --fail-envelope <reason>
                    Write a failed lane envelope for a step that ran before (or
                    instead of) the sweep, e.g. a self-test failure
`;

type Args = {
  modules: readonly ModuleId[];
  affected: boolean;
  base: string;
  report: string | undefined;
  reportDir: string | undefined;
  summary: string | undefined;
  listAffected: boolean;
  failEnvelope: string | undefined;
  shard: Shard | undefined;
  expectShards: number | undefined;
};

/** One-based slice of a module's mutated sources: `--shard 2/4`. */
type Shard = { index: number; count: number };

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
    'fail-envelope': { type: 'string' },
    shard: { type: 'string' },
    'expect-shards': { type: 'string' },
  });
  return {
    modules: parseModules(values.modules),
    affected: Boolean(values.affected),
    base: values.base ?? 'origin/main',
    report: values.report ?? (values['no-run'] ? DEFAULT_REPORT_PATH : undefined),
    reportDir: values['report-dir'],
    summary: values.summary,
    listAffected: Boolean(values['list-affected']),
    failEnvelope: values['fail-envelope'],
    shard: parseShard(values.shard),
    expectShards: values['expect-shards'] ? Number(values['expect-shards']) : undefined,
  };
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

// The JSON report path comes from the config (Stryker's CLI takes no nested
// reporter options), so a run always writes DEFAULT_REPORT_PATH.
/**
 * Balances a module's sources across `count` jobs. Mutant count tracks file size
 * closely enough that greedy longest-first packing keeps the slowest slice near
 * the mean — the alternative is one 1,277-mutant selectors job that outruns both
 * the 30-minute acceptance budget and its own timeout.
 */
function shardFiles(files: readonly string[], shard: Shard, root: string): string[] {
  const bins: { size: number; files: string[] }[] = Array.from({ length: shard.count }, () => ({
    size: 0,
    files: [],
  }));
  const weighed = files
    .map((file) => ({ file, size: fs.statSync(path.join(root, file)).size }))
    .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  for (const { file, size } of weighed) {
    const bin = bins.reduce((smallest, next) => (next.size < smallest.size ? next : smallest));
    bin.files.push(file);
    bin.size += size;
  }
  return bins[shard.index - 1]!.files.sort();
}

async function runStryker(
  modules: readonly ModuleId[],
  reportPath: string,
  shard: Shard | undefined,
): Promise<void> {
  const absolute = path.isAbsolute(reportPath) ? reportPath : path.join(repoRoot, reportPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.rmSync(absolute, { force: true });
  // The suite Stryker replays per mutant is derived from Vitest's module graph
  // over the mutated files, not hand-listed; see scripts/mutation/test-scope.ts.
  const globs = mutateGlobs(modules);
  const all = expandMutateFiles(globs, repoRoot);
  // A sharded job mutates concrete files, so the slice is exact rather than a
  // glob the next contributor has to keep in step with the registry.
  const mutate = shard ? shardFiles(all, shard, repoRoot) : globs;
  const scopePath = path.join(repoRoot, TEST_SCOPE_PATH);
  const testFiles = relatedTestFiles(shard ? mutate : all, repoRoot);
  writeTestScope(testFiles, scopePath);
  process.stdout.write(
    `mutation: ${modules.join(', ')}${shard ? ` shard ${shard.index}/${shard.count}` : ''} -> ` +
      `${shard ? mutate.length : all.length} source(s), ${testFiles.length} related test file(s)\n`,
  );

  // Stryker's `--mutate` takes one comma-separated value, not repeated args.
  const args = ['exec', 'stryker', 'run', CONFIG_PATH, '--mutate', mutate.join(',')];
  const result = await runCmdStreaming('pnpm', args, {
    cwd: repoRoot,
    allowFailure: true,
    env: { ...process.env, [TEST_SCOPE_ENV]: scopePath },
    onStdoutChunk: (chunk) => void process.stdout.write(chunk),
    onStderrChunk: (chunk) => void process.stderr.write(chunk),
  });
  // Stryker exits non-zero on a low score too; this lane reports scores rather
  // than judging them, so only a missing report is fatal here.
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `Stryker produced no report at ${reportPath} (exit ${result.exitCode}). See output above.`,
    );
  }
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
    return { id, score: null, killed: null, survived: null, total: null, timeout: null };
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
    // The lane never judges a score, so the result states whether the lane
    // produced a report at all.
    result: state.stage === 'complete' ? 'pass' : 'fail',
    data: {
      scope: state.affected ? 'affected' : 'full-sweep',
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
function readShardedReports(dir: string): { report: StrykerReport; count: number } {
  const root = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
  // Shard artifacts also carry the lane envelope and the derived test scope, so
  // the report is selected by name rather than by "every .json here".
  const files = fs
    .globSync(`**/${path.basename(DEFAULT_REPORT_PATH)}`, { cwd: root })
    .map((file) => path.join(root, file))
    .sort();
  if (files.length === 0) throw new Error(`No Stryker JSON reports found under ${dir}`);
  process.stdout.write(`mutation: merging ${files.length} shard report(s) from ${dir}\n`);
  return { report: mergeReports(files.map(readReport)), count: files.length };
}

async function produceReport(
  modules: readonly ModuleId[],
  reportPath: string | undefined,
  shard: Shard | undefined,
): Promise<StrykerReport> {
  if (!reportPath) await runStryker(modules, DEFAULT_REPORT_PATH, shard);
  return readReport(reportPath ?? DEFAULT_REPORT_PATH);
}

/**
 * A merged shard set is only a sweep if every expected shard reported and every
 * requested module has mutants — sub-sharded modules make the second check too
 * weak alone, since a surviving slice still covers its module. `summarizeReport`
 * scores an absent module as 0, so without this a dead shard would be published
 * as a `complete`/`pass` envelope claiming the sweep happened.
 *
 * Both verdicts run after the table is published: the kernels that did complete
 * are the part of the run still worth reading on a failed-shard day.
 */
function assertCompleteSweep(state: LaneState, dir: string, shards: number, args: Args): void {
  if (args.expectShards !== undefined && shards !== args.expectShards) {
    throw new Error(
      `Incomplete shard set from ${dir}: ${shards} report(s), expected ${args.expectShards}. ` +
        'A shard job failed or its artifact is absent; the aggregate is not a sweep.',
    );
  }
  const missing = state.scores.filter((score) => score.total === 0).map((score) => score.module);
  if (missing.length === 0) return;
  throw new Error(
    `Incomplete shard set from ${dir}: no mutants for ${missing.join(', ')}. ` +
      'A shard job failed or its artifact is absent; the aggregate is not a sweep.',
  );
}

/**
 * Reads shard reports, an existing report, or runs Stryker — and scores them.
 * Returns the shard count when the source was a shard directory.
 */
async function scoreModules(args: Args, state: LaneState): Promise<number | undefined> {
  state.stage = args.reportDir || args.report ? 'report' : 'stryker';
  const shards = args.reportDir ? readShardedReports(args.reportDir) : undefined;
  const report = shards?.report ?? (await produceReport(state.modules, args.report, args.shard));

  state.stage = 'score';
  state.scores = summarizeReport(report, state.modules);
  return shards?.count;
}

async function sweep(args: Args, state: LaneState): Promise<number> {
  state.stage = 'select';
  // Same selection the PR matrix uses, so the reporting job can never score
  // mutants the `select` job decided not to spend.
  if (args.affected) {
    state.modules = [...new Set(affectedMatrix(args.base).map((entry) => entry.module))];
  }
  if (state.modules.length === 0) {
    process.stdout.write('mutation: no decision-kernel modules affected — nothing to mutate.\n');
    state.stage = 'complete';
    return 0;
  }

  const shards = await scoreModules(args, state);

  const title = args.affected
    ? 'Mutation score — affected decision kernels'
    : 'Mutation score — decision kernels';
  emit(renderReport(state.scores, state.provenance, { title }), args.summary);

  if (args.reportDir) assertCompleteSweep(state, args.reportDir, shards ?? 0, args);
  state.stage = 'complete';
  return 0;
}

/**
 * Sources of the lane itself: a change here must prove itself on real mutants.
 * These are also the only paths that can produce a non-empty matrix, so
 * `mutation-affected.yml` triggers on exactly them — asserted by
 * `workflow.test.ts`, since a filter that missed one would let a harness change
 * merge unproven, and any wider filter only buys a no-op job.
 */
export const LANE_TOOLING = ['scripts/mutation/', 'scripts/lib/', 'stryker.config.json'];

/**
 * The PR lane's matrix: empty unless the diff touches the harness, otherwise the
 * canary plus whatever kernels that same diff derives. The kernel report that
 * pays is the weekly sweep, so the PR lane spends mutants on one thing only —
 * proving the harness still runs end to end when the harness changes. Selecting
 * on derived kernel ownership alone would run the full ten-shard sweep on 24 of
 * the last 40 merged PRs, a per-PR full sweep for a report nobody gates on.
 */
export function affectedMatrixFor(
  changed: readonly string[],
  root: string = repoRoot,
): ShardSpec[] {
  const touchesLane = changed.some((file) =>
    LANE_TOOLING.some((prefix) => normalizePath(file).startsWith(prefix)),
  );
  if (!touchesLane) return [];
  const modules = new Set(derivedAffectedModules(changed, root));
  // Lane sources own no kernel, so a tooling-only diff derives nothing: without
  // the canary the lane would select zero mutants and prove nothing.
  modules.add(LANE_CANARY);
  return shardMatrix(ALL_MODULE_IDS.filter((id) => modules.has(id)));
}

function affectedMatrix(base: string): ShardSpec[] {
  return affectedMatrixFor(changedFiles(base));
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
    process.stdout.write(`${JSON.stringify(affectedMatrix(args.base))}\n`);
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
