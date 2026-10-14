// Entry point for the coverage-based CRAP verdict: `pnpm check:coverage-crap [--base <ref> | --all]`.
//
// Reuses the Istanbul map `pnpm test:coverage` already wrote (never runs coverage a second time),
// drops records with impossible counts, and asks fallow to score the functions the diff against
// <base> touches, or every function with --all.
//
// `--base` (a PR) blocks: it exits 1 when a touched function scores at or above the threshold, and
// also when the reports cannot be trusted to answer — a missing or malformed map, a map with fewer
// files than the same run enumerated, or a touched file the map dropped or never recorded. `--all`
// (the `main` report) stays report-only, because `main` carries debt on purpose: it exits 0 once it
// has a report to show. Attribution is rename-aware — `readChangedLinesDiff` pairs a pure move at
// 90%, so relocating a file owes nothing for the functions that moved with it.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { parseLcov } from '../coverage-changed/model.ts';
import { parseUnifiedDiff, readChangedLinesDiff } from '../lib/repo-git.ts';
import { repoRelativePath } from '../lib/repo-path.ts';
import {
  coverageMapPaths,
  decideCrapVerdict,
  parseFallowJsonReport,
  parseIstanbulCoverageMap,
  readCrapFindings,
  readCrapOverrides,
  readEstimatedFindings,
  readTouchedFiles,
  renderCrapAnnotations,
  renderCrapReport,
  sanitizeIstanbulCoverage,
  type CrapFinding,
  type CrapScope,
  type IstanbulCoverageMap,
  type TouchedFile,
} from './model.ts';

const USAGE = 'Usage: pnpm check:coverage-crap [--base <ref> | --all]\n';
const COVERAGE_PATH = 'coverage/coverage-istanbul.json';
const LCOV_PATH = 'coverage/lcov.info';
const SANITIZED_PATH = 'coverage/fallow-crap-coverage.json';
const FALLOW_CONFIG = '.fallowrc.json';
const CRAP_THRESHOLD = 30;
const FALLOW_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// This repository's own pinned fallow, beside the checkout this script was loaded from. Resolving
// it from the analyzed root instead would let a second checkout supply a different version.
const FALLOW_BIN = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  'fallow',
  'bin',
  'fallow',
);

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? 'no output';
}

/** Drops an `AppError` prefix so the report names the cause rather than the wrapper. */
function describe(error: unknown): string {
  return error instanceof Error ? firstLine(error.message) : String(error);
}

/**
 * Says out loud that no verdict was reached. These cases exit before a report exists, so they go to
 * stderr rather than heading a table of nothing, which would read as a clean result in the logs.
 */
function refuse(reason: string): number {
  process.stderr.write(`check:coverage-crap: no trustworthy verdict — ${reason}\n`);
  return 1;
}

/** The diff this verdict is scoped to, as fallow receives it on stdin. */
function readScopedDiff(
  root: string,
  base: string,
): { diff: string; touched: readonly TouchedFile[] } {
  const diff = readChangedLinesDiff(root, base);
  return { diff, touched: readTouchedFiles(parseUnifiedDiff(diff)) };
}

/**
 * The files the coverage run enumerated, per lcov, or null when it wrote no record of that. A run
 * that lists no files cannot be that record either, and reaching the verdict as an empty set would
 * satisfy every completeness check at once.
 */
function readEnumeratedPaths(root: string): Set<string> | null {
  const lcovPath = path.resolve(root, LCOV_PATH);
  if (!fs.existsSync(lcovPath)) return null;
  const enumerated = new Set(parseLcov(fs.readFileSync(lcovPath, 'utf8'), root).keys());
  return enumerated.size > 0 ? enumerated : null;
}

/** What one coverage run and one diff say, as far as they can be read at all. */
type CrapInputs = Readonly<{
  /** Every file the run recorded counters for, including records dropped as corrupt below. */
  mapPaths: ReadonlySet<string>;
  /** Every file the run listed in lcov, or null when it wrote nothing usable. */
  enumeratedPaths: ReadonlySet<string> | null;
  /** The base...HEAD diff fallow scores against, on stdin; empty in `all` scope. */
  diff: string;
  touched: readonly TouchedFile[];
  /** Records the sanitizer refused, as repo-relative paths. */
  dropped: readonly string[];
}>;

/**
 * Reads the two reports of one coverage run plus this change's diff, or names the reason there is
 * nothing to decide from. A verdict computed from an unreadable map would read as "no findings",
 * which is indistinguishable from a clean branch, so those cases stop here.
 */
function gatherCrapInputs(
  root: string,
  base: string,
  scope: CrapScope,
): CrapInputs | { refusal: string } {
  const coveragePath = path.resolve(root, COVERAGE_PATH);
  if (!fs.existsSync(coveragePath)) {
    return {
      refusal: `no Istanbul coverage map at ${coveragePath}. Run \`pnpm test:coverage\` first.`,
    };
  }
  let map: IstanbulCoverageMap;
  try {
    map = parseIstanbulCoverageMap(fs.readFileSync(coveragePath, 'utf8'));
  } catch (error: unknown) {
    return { refusal: `${coveragePath}: ${describe(error)}` };
  }

  let diff = '';
  let touched: readonly TouchedFile[] = [];
  if (scope === 'touched') {
    try {
      ({ diff, touched } = readScopedDiff(root, base));
    } catch (error: unknown) {
      return { refusal: `the diff against ${base} failed: ${describe(error)}` };
    }
  }

  const { map: sanitized, dropped } = sanitizeIstanbulCoverage(map);
  fs.writeFileSync(path.resolve(root, SANITIZED_PATH), JSON.stringify(sanitized));

  // lcov is the same coverage run's own list of the files it enumerated, which is what makes a
  // touched file absent from the map detectable. Whether a missing one is worth reporting is the
  // verdict's call, not this reader's.
  return {
    mapPaths: coverageMapPaths(map, root),
    enumeratedPaths: readEnumeratedPaths(root),
    diff,
    touched,
    dropped: dropped.map((file) => repoRelativePath(file, root)),
  };
}

/** Scores the sanitized map against `.fallowrc.json`, scoped to this diff in `touched` scope. */
function runFallowHealth(
  root: string,
  scope: CrapScope,
  diff: string,
): { stdout: string } | { failure: string } {
  const fallow = runCmdSync(
    process.execPath,
    [
      FALLOW_BIN,
      'health',
      '--config',
      FALLOW_CONFIG,
      '--complexity',
      '--max-crap',
      String(CRAP_THRESHOLD),
      '--coverage',
      SANITIZED_PATH,
      ...(scope === 'touched' ? ['--diff-stdin'] : []),
      '--report-only',
      '--format',
      'json',
      '--quiet',
    ],
    {
      cwd: root,
      allowFailure: true,
      maxBuffer: FALLOW_MAX_BUFFER_BYTES,
      ...(scope === 'touched' ? { stdin: diff } : {}),
    },
  );
  return fallow.exitCode === 0
    ? { stdout: fallow.stdout }
    : { failure: `fallow health failed:\n${fallow.stderr}` };
}

/** Scores what was gathered, prints the verdict, and returns the process exit code. */
function reportCrapVerdict(root: string, scope: CrapScope, inputs: CrapInputs): number {
  const health = runFallowHealth(root, scope, inputs.diff);
  if ('failure' in health) {
    process.stderr.write(`check:coverage-crap: ${health.failure}\n`);
    return 1;
  }
  const report = parseFallowJsonReport(health.stdout);
  const findings = readCrapFindings(report, CRAP_THRESHOLD);
  const verdict = decideCrapVerdict({
    scope,
    findings,
    estimated: readEstimatedFindings(report, CRAP_THRESHOLD),
    touched: inputs.touched,
    dropped: new Set(inputs.dropped),
    // Pre-sanitizer on purpose: a record the sanitizer dropped is reported as corrupt, and a file
    // the run measured is not also missing from the map.
    mapPaths: inputs.mapPaths,
    enumeratedPaths: inputs.enumeratedPaths,
  });
  const rendered = renderCrapReport({
    findings,
    dropped: inputs.dropped,
    threshold: CRAP_THRESHOLD,
    scope,
    verdict,
    overrides: readCrapOverrides(report),
  });
  publish(rendered, scope, verdict.offenders);
  return verdict.blocking ? 1 : 0;
}

/** The report goes to stdout, to the job summary, and — the debt only — onto the PR's diff. */
function publish(rendered: string, scope: CrapScope, offenders: readonly CrapFinding[]): void {
  process.stdout.write(rendered);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, rendered);
  if (scope === 'touched' && process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(renderCrapAnnotations(offenders));
  }
}

export function run(argv: readonly string[], cwd?: string): number {
  const values = parseScriptArgs(argv, USAGE, {
    base: { type: 'string', default: 'origin/main' },
    all: { type: 'boolean', default: false },
  });
  const base = values.base ?? 'origin/main';
  const scope: CrapScope = values.all ? 'all' : 'touched';
  const root = cwd ?? runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();

  const inputs = gatherCrapInputs(root, base, scope);
  if ('refusal' in inputs) return refuse(inputs.refusal);
  return reportCrapVerdict(root, scope, inputs);
}

// exitCode, not exit(): a large report written to a pipe must drain before the process ends.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(
      `check:coverage-crap: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
