// Entry point for the coverage-based CRAP verdict: `pnpm check:coverage-crap [--base <ref> | --all]`.
//
// Reuses the Istanbul map `pnpm test:coverage` already wrote (never runs coverage a second time),
// refuses it unless the stamp beside it proves this checkout wrote it, drops records with impossible
// counts, and asks fallow to score the functions the diff against <base> touches, or every function
// with --all.
//
// `--base` (a PR) blocks: it exits 1 when a touched function scores at or above the threshold, and
// also when the reports cannot be trusted to answer — no stamp, a stamp from another commit or another
// working tree, a map recorded in another root, or a touched file the run was told to instrument and
// did not record. `--all` (the `main` report) stays report-only, because `main` carries debt on
// purpose: it exits 0 once it has a report to show, so it asks none of the per-file questions a stamp
// and a diff would answer. Attribution is rename-aware — `readChangedLinesDiff` pairs a pure move at
// 90%, so relocating a file owes nothing for the functions that moved with it.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { parseScriptArgs } from '../lib/cli-args.ts';
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
import {
  declaresWholeFileIgnore,
  describeStampMismatch,
  isInstrumentedPath,
  verifyCoverageStamp,
  type CoverageConfig,
} from './stamp.ts';

const USAGE = 'Usage: pnpm check:coverage-crap [--base <ref> | --all]\n';
// One spelling for the reports directory, which the writer side takes from the Vitest config: the reports
// all live inside it, so moving the lane's output is a one-line change here.
const COVERAGE_DIR = 'coverage';
const MAP_FILE = 'coverage-istanbul.json';
const SANITIZED_PATH = path.join(COVERAGE_DIR, 'fallow-crap-coverage.json');
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

/** What one coverage run and one diff say, as far as they can be read at all. */
type CrapInputs = Readonly<{
  /** Every file the run recorded counters for, including records dropped as corrupt below. */
  mapPaths: ReadonlySet<string>;
  /** The base...HEAD diff fallow scores against, on stdin; empty in `all` scope. */
  diff: string;
  touched: readonly TouchedFile[];
  /** Records the sanitizer refused, as repo-relative paths. */
  dropped: readonly string[];
  /** The include/exclude the verified stamp declares; null when no stamp was required of this run. */
  coverage: CoverageConfig | null;
  /** Touched files whose source declares itself outside coverage, which no run can record. */
  ignoredFiles: ReadonlySet<string>;
}>;

/** A touched file's bytes, or undefined when the working tree no longer holds it. */
function readSource(absolutePath: string): string | undefined {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/**
 * The touched files this checkout can still answer for, and which of them declare themselves outside
 * coverage. A diff can name a file the working tree no longer holds, and no run can record a file that is
 * gone, so the verdict is asked none of its questions.
 */
function readTouchedSources(
  root: string,
  touched: readonly TouchedFile[],
  coverage: CoverageConfig,
): Readonly<{ held: readonly TouchedFile[]; ignored: ReadonlySet<string> }> {
  const held: TouchedFile[] = [];
  const ignored = new Set<string>();
  for (const file of touched) {
    const source = readSource(path.resolve(root, file.path));
    if (source === undefined) continue;
    held.push(file);
    // Only a file the map owes a record for can be excused from owing one, and that is the only question a
    // pragma answers. Everything else the diff touches — a document, a fixture, a binary — is out of scope
    // by declaration, so parsing it would spend a JavaScript parse to learn nothing.
    if (isInstrumentedPath(file.path, coverage) && declaresWholeFileIgnore(file.path, source)) {
      ignored.add(file.path);
    }
  }
  return { held, ignored };
}

/**
 * Reads the coverage reports plus this change's diff, or names the reason there is nothing to decide
 * from. A verdict computed from an unreadable or unattributable map would read as "no findings", which
 * is indistinguishable from a clean branch, so those cases stop here.
 */
function gatherCrapInputs(
  root: string,
  base: string,
  scope: CrapScope,
): CrapInputs | { refusal: string } {
  const coverageDir = path.resolve(root, COVERAGE_DIR);
  const mapPath = path.join(coverageDir, MAP_FILE);
  if (!fs.existsSync(mapPath)) {
    return { refusal: `no Istanbul coverage map at ${mapPath}. Run \`pnpm test:coverage\` first.` };
  }
  let map: IstanbulCoverageMap;
  try {
    map = parseIstanbulCoverageMap(fs.readFileSync(mapPath, 'utf8'));
  } catch (error: unknown) {
    return { refusal: `${mapPath}: ${describe(error)}` };
  }
  const mapPaths = coverageMapPaths(map, root);
  // Vitest writes the map's keys absolute, so a report from another root relativizes outside this one
  // and can join none of its files. That must not read as "no file was measured", and the stamp cannot
  // catch it: two checkouts of one commit carry the same HEAD and the same bytes.
  const outside = [...mapPaths].find((file) => file.startsWith('../'));
  if (outside !== undefined) {
    return {
      refusal:
        `${mapPath} records files outside this checkout, for example ${outside}. ` +
        'It was written by a run in another root; run `pnpm test:coverage` here.',
    };
  }

  let diff = '';
  let touched: readonly TouchedFile[] = [];
  let ignoredFiles: ReadonlySet<string> = new Set();
  // In `all` scope nothing is attributed to a diff, so there is no per-file question for a stamp or an
  // include list to answer, and `coverage` stays null rather than lending its scope to verdicts it
  // never made.
  let coverage: CoverageConfig | null = null;
  if (scope === 'touched') {
    try {
      diff = readChangedLinesDiff(root, base);
    } catch (error: unknown) {
      return { refusal: `the diff against ${base} failed: ${describe(error)}` };
    }
    const verified = verifyCoverageStamp(coverageDir, root);
    if ('mismatch' in verified) return { refusal: describeStampMismatch(verified.mismatch) };
    coverage = verified.stamp;
    const sources = readTouchedSources(root, readTouchedFiles(parseUnifiedDiff(diff)), coverage);
    touched = sources.held;
    ignoredFiles = sources.ignored;
  }

  const { map: sanitized, dropped } = sanitizeIstanbulCoverage(map);
  fs.writeFileSync(path.resolve(root, SANITIZED_PATH), JSON.stringify(sanitized));

  return {
    mapPaths,
    diff,
    touched,
    dropped: dropped.map((file) => repoRelativePath(file, root)),
    coverage,
    ignoredFiles,
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
    // Pre-sanitizer on purpose: a record the sanitizer dropped is corrupt, not missing from the map.
    mapPaths: inputs.mapPaths,
    coverage: inputs.coverage,
    ignoredFiles: inputs.ignoredFiles,
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
