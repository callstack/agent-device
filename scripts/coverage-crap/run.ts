// Entry point for the coverage-based CRAP report: `pnpm check:coverage-crap [--base <ref> | --all]`.
//
// Reuses the Istanbul map `pnpm test:coverage` already wrote (never runs coverage a second time),
// drops records with impossible counts, and asks fallow to score the functions the diff against
// <base> touches, or every function with --all. Report-only: it prints the functions at or above
// the threshold to stdout and the GitHub job summary (touched functions also as warning
// annotations), and exits 0 once it has a verdict.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { readChangedLinesDiff } from '../lib/repo-git.ts';
import {
  parseFallowJsonReport,
  readCrapFindings,
  renderCrapAnnotations,
  renderCrapReport,
  sanitizeIstanbulCoverage,
  type CrapScope,
  type IstanbulCoverageMap,
} from './model.ts';

const USAGE = 'Usage: pnpm check:coverage-crap [--base <ref> | --all]\n';
const COVERAGE_PATH = 'coverage/coverage-istanbul.json';
const SANITIZED_PATH = 'coverage/fallow-crap-coverage.json';
const DIFF_PATH = 'coverage/fallow-crap.diff';
const FALLOW_CONFIG = 'fallow-crap.json';
const CRAP_THRESHOLD = 30;
const FALLOW_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function run(argv: readonly string[], cwd?: string): number {
  const values = parseScriptArgs(argv, USAGE, {
    base: { type: 'string', default: 'origin/main' },
    all: { type: 'boolean', default: false },
  });
  const base = values.base ?? 'origin/main';
  const scope: CrapScope = values.all ? 'all' : 'touched';
  const root = cwd ?? runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const coveragePath = path.resolve(root, COVERAGE_PATH);
  if (!fs.existsSync(coveragePath)) {
    process.stderr.write(
      `check:coverage-crap: no Istanbul coverage map at ${coveragePath}. Run \`pnpm test:coverage\` first.\n`,
    );
    return 1;
  }

  const { map, dropped } = sanitizeIstanbulCoverage(
    JSON.parse(fs.readFileSync(coveragePath, 'utf8')) as IstanbulCoverageMap,
  );
  fs.writeFileSync(path.resolve(root, SANITIZED_PATH), JSON.stringify(map));
  if (scope === 'touched') {
    fs.writeFileSync(path.resolve(root, DIFF_PATH), readChangedLinesDiff(root, base));
  }

  const fallow = runCmdSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'fallow', 'bin', 'fallow'),
      'health',
      '--config',
      FALLOW_CONFIG,
      '--complexity',
      '--max-crap',
      String(CRAP_THRESHOLD),
      '--coverage',
      SANITIZED_PATH,
      ...(scope === 'touched' ? ['--diff-file', DIFF_PATH] : []),
      '--report-only',
      '--format',
      'json',
      '--quiet',
    ],
    { cwd: root, allowFailure: true, maxBuffer: FALLOW_MAX_BUFFER_BYTES },
  );
  if (fallow.exitCode !== 0) {
    process.stderr.write(`check:coverage-crap: fallow health failed:\n${fallow.stderr}\n`);
    return 1;
  }
  const findings = readCrapFindings(parseFallowJsonReport(fallow.stdout), CRAP_THRESHOLD);
  const report = renderCrapReport({
    findings,
    dropped: dropped.map((file) => path.relative(root, file)),
    threshold: CRAP_THRESHOLD,
    scope,
  });
  process.stdout.write(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, report);
  if (scope === 'touched' && process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(renderCrapAnnotations(findings));
  }
  return 0;
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
