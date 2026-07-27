// Entrypoint for the decision-kernel mutation lane (issue #1415).
//
//   pnpm mutation:run                       full sweep + ratchet check
//   pnpm mutation:baseline                  full sweep, then record the scores
//   pnpm mutation:check --report <file>     ratchet an existing Stryker report
//   pnpm mutation:affected --base origin/main
//                                           PR lane: mutate only the kernel
//                                           modules the diff touches
//
// The weekly workflow runs the full sweep and writes the rendered report to the
// job summary plus an artifact; the PR lane runs the affected subset and only
// fails once the baseline has graduated to `gating: true`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdStreaming, runCmdSync } from '../../src/utils/exec.ts';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { laneEnvelope } from '../lib/lane-envelope.ts';
import { ALL_MODULE_IDS, isModuleId, mutateGlobs, type ModuleId } from './modules.ts';
import { derivedAffectedModules } from './ownership.ts';
import { renderReport } from './report.ts';
import {
  applyRun,
  emptyBaseline,
  evaluateRatchet,
  type Baseline,
  type Provenance,
  type RatchetResult,
} from './ratchet.ts';
import { mergeReports, summarizeReport, type ModuleScore, type StrykerReport } from './score.ts';
import {
  expandMutateFiles,
  relatedTestFiles,
  TEST_SCOPE_ENV,
  writeTestScope,
} from './test-scope.ts';

const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();

const CONFIG_PATH = 'stryker.config.json';
const BASELINE_PATH = 'mutation-baselines/decision-kernels.json';
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
  --update          Record the run into the baseline (ratchet + graduation)
  --summary <file>  Also write the markdown report to <file>
  --no-run          Alias for --report with the default report path
  --list-affected   Print the affected module ids as JSON and exit (shard matrix)
`;

type Args = {
  modules: readonly ModuleId[];
  affected: boolean;
  base: string;
  report: string | undefined;
  reportDir: string | undefined;
  update: boolean;
  summary: string | undefined;
  listAffected: boolean;
};

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
    update: { type: 'boolean', default: false },
    summary: { type: 'string' },
    'no-run': { type: 'boolean', default: false },
    'list-affected': { type: 'boolean', default: false },
  });
  return {
    modules: parseModules(values.modules),
    affected: Boolean(values.affected),
    base: values.base ?? 'origin/main',
    report: values.report ?? (values['no-run'] ? DEFAULT_REPORT_PATH : undefined),
    reportDir: values['report-dir'],
    update: Boolean(values.update),
    summary: values.summary,
    listAffected: Boolean(values['list-affected']),
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

function readBaseline(root: string = repoRoot): Baseline {
  const file = path.join(root, BASELINE_PATH);
  if (!fs.existsSync(file)) return emptyBaseline();
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
}

function writeBaseline(baseline: Baseline, root: string = repoRoot): void {
  const file = path.join(root, BASELINE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
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
async function runStryker(modules: readonly ModuleId[], reportPath: string): Promise<void> {
  const absolute = path.isAbsolute(reportPath) ? reportPath : path.join(repoRoot, reportPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.rmSync(absolute, { force: true });
  // The suite Stryker replays per mutant is derived from Vitest's module graph
  // over the mutated files, not hand-listed; see scripts/mutation/test-scope.ts.
  const globs = mutateGlobs(modules);
  const scopePath = path.join(repoRoot, TEST_SCOPE_PATH);
  const testFiles = relatedTestFiles(expandMutateFiles(globs, repoRoot), repoRoot);
  writeTestScope(testFiles, scopePath);
  process.stdout.write(
    `mutation: ${modules.join(', ')} -> ${testFiles.length} related test file(s)\n`,
  );

  // Stryker's `--mutate` takes one comma-separated value, not repeated args.
  const args = ['exec', 'stryker', 'run', CONFIG_PATH, '--mutate', globs.join(',')];
  const result = await runCmdStreaming('pnpm', args, {
    cwd: repoRoot,
    allowFailure: true,
    env: { ...process.env, [TEST_SCOPE_ENV]: scopePath },
    onStdoutChunk: (chunk) => void process.stdout.write(chunk),
    onStderrChunk: (chunk) => void process.stderr.write(chunk),
  });
  // Stryker exits non-zero on a low score too; the ratchet — not Stryker's own
  // thresholds — owns the verdict, so only a missing report is fatal here.
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
type Stage = 'select' | 'stryker' | 'report' | 'ratchet' | 'complete';

type LaneState = {
  stage: Stage;
  provenance: Provenance;
  baseline: Baseline;
  modules: readonly ModuleId[];
  affected: boolean;
  scores: readonly ModuleScore[];
  result: RatchetResult | undefined;
  error: string | undefined;
};

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
  const envelope = laneEnvelope({
    lane: LANE_ID,
    commit: runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim(),
    tool: { stryker: state.provenance.strykerVersion },
    configHash: state.provenance.configHash,
    startedAtMs,
    result: state.stage === 'complete' && !state.result?.failed ? 'pass' : 'fail',
    data: {
      scope: state.affected ? 'affected' : 'full-sweep',
      stage: state.stage,
      error: state.error ?? null,
      modules: state.modules.map((id) => {
        const score = state.scores.find((entry) => entry.module === id);
        return {
          id,
          score: score?.score ?? null,
          killed: score?.killed ?? null,
          total: score?.total ?? null,
          status: state.result?.verdicts.find((verdict) => verdict.module === id)?.status ?? null,
        };
      }),
      gating: state.baseline.gating,
      stableRuns: state.baseline.stableRuns,
      requiredStableRuns: state.baseline.requiredStableRuns,
    },
  });
  const file = path.join(repoRoot, ENVELOPE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(
    `\nLane envelope (${ENVELOPE_PATH}): ${envelope.result} at stage ${state.stage} in ` +
      `${Math.round(envelope.durationMs / 1000)}s at ${envelope.commit.slice(0, 12)}.\n`,
  );
}

function readReport(file: string): StrykerReport {
  const absolute = path.isAbsolute(file) ? file : path.join(repoRoot, file);
  return JSON.parse(fs.readFileSync(absolute, 'utf8')) as StrykerReport;
}

function readShardedReports(dir: string): StrykerReport {
  const root = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
  // Shard artifacts also carry the lane envelope and the derived test scope, so
  // the report is selected by name rather than by "every .json here".
  const files = fs
    .globSync(`**/${path.basename(DEFAULT_REPORT_PATH)}`, { cwd: root })
    .map((file) => path.join(root, file))
    .sort();
  if (files.length === 0) throw new Error(`No Stryker JSON reports found under ${dir}`);
  process.stdout.write(`mutation: merging ${files.length} shard report(s) from ${dir}\n`);
  return mergeReports(files.map(readReport));
}

async function produceReport(
  modules: readonly ModuleId[],
  reportPath: string | undefined,
): Promise<StrykerReport> {
  if (!reportPath) await runStryker(modules, DEFAULT_REPORT_PATH);
  return readReport(reportPath ?? DEFAULT_REPORT_PATH);
}

function recordRun(args: Args, state: LaneState, result: RatchetResult): void {
  const next = applyRun(state.baseline, state.scores, result, {
    provenance: state.provenance,
    now: new Date().toISOString(),
    // Only the full sweep proves stability; an affected subset says nothing
    // about the modules it skipped.
    countsTowardGraduation: !args.affected && state.modules.length === ALL_MODULE_IDS.length,
  });
  writeBaseline(next);
  process.stdout.write(
    `\nBaseline updated (${BASELINE_PATH}): ${next.stableRuns}/${next.requiredStableRuns} ` +
      `stable runs, gating ${next.gating ? 'on' : 'off'}.\n`,
  );
}

async function sweep(args: Args, state: LaneState): Promise<number> {
  // Test attribution is derived from the import graph, not a listed set of test
  // files: see scripts/mutation/ownership.ts.
  state.modules = args.affected
    ? derivedAffectedModules(changedFiles(args.base), repoRoot)
    : args.modules;
  if (state.modules.length === 0) {
    process.stdout.write('mutation: no decision-kernel modules affected — nothing to mutate.\n');
    state.stage = 'complete';
    return 0;
  }

  state.stage = args.reportDir || args.report ? 'report' : 'stryker';
  const report = args.reportDir
    ? readShardedReports(args.reportDir)
    : await produceReport(state.modules, args.report);

  state.stage = 'ratchet';
  state.scores = summarizeReport(report, state.modules);
  const result = evaluateRatchet(state.scores, state.baseline, state.provenance);
  state.result = result;

  const title = args.affected
    ? 'Mutation score — affected decision kernels'
    : 'Mutation score — decision kernels';
  emit(renderReport(result, state.baseline, state.provenance, { title }), args.summary);

  if (args.update) recordRun(args, state, result);
  state.stage = 'complete';
  return result.failed ? 1 : 0;
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const startedAtMs = Date.now();
  const args = parseMutationArgs(argv);
  if (args.listAffected) {
    // Selection only — no lane run, so no envelope. The shard jobs that consume
    // this matrix each write their own.
    process.stdout.write(
      `${JSON.stringify(derivedAffectedModules(changedFiles(args.base), repoRoot))}\n`,
    );
    return 0;
  }
  // Provenance and baseline are read before any work so a crashed sweep still
  // reports which tool and config it crashed with.
  const state: LaneState = {
    stage: 'select',
    provenance: readProvenance(),
    baseline: readBaseline(),
    modules: args.modules,
    affected: args.affected,
    scores: [],
    result: undefined,
    error: undefined,
  };
  try {
    return await sweep(args, state);
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
