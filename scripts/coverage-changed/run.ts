// Entry point for the changed-line coverage gate (#1418):
// `pnpm check:coverage-changed [--base <ref>]`.
//
// Reuses the lcov report that `pnpm test:coverage` already produced (never runs
// coverage a second time), joins it with `git diff --unified=0 <base>...HEAD`,
// and fails when changed-line coverage is below the threshold. Renames are
// detected at RENAME_SIMILARITY regardless of the host's `diff.renames`, so a
// moved file owes only the hunks that differ from its source. A PR carrying
// the `coverage-waiver` label skips the failure but still prints every number.
// The same markdown report goes to stdout and to the GitHub job summary; it
// includes changed-branch coverage and the count of changed executable lines
// excluded from coverage, both non-gating.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { parseScriptArgs } from '../lib/cli-args.ts';
import {
  computeChangedCoverage,
  parseLcov,
  parseUnifiedDiff,
  type ChangedCoverageResult,
} from './model.ts';

const USAGE = 'Usage: pnpm check:coverage-changed [--base <ref>]\n';
const LCOV_PATH = 'coverage/lcov.info';
const RENAME_SIMILARITY = '90%';
const GIT_DIFF_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function fmtPct(pct: number | null): string {
  return pct === null ? 'n/a' : `${pct.toFixed(2)}%`;
}

function render(result: ChangedCoverageResult): string {
  const verdict = result.waived
    ? 'WAIVED (`coverage-waiver` label)'
    : result.passed
      ? 'PASS'
      : 'FAIL';
  const lines = [
    `## Changed-line coverage gate: ${verdict}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Changed-line coverage (gating, threshold ${result.threshold}%) | ${result.coveredLines}/${result.totalLines} (${fmtPct(result.pct)}) |`,
    `| Changed-branch coverage (non-gating) | ${result.branch.covered}/${result.branch.total} (${fmtPct(result.branch.pct)}) |`,
    `| Changed executable lines excluded (non-gating) | ${result.excluded.totalLines} |`,
  ];
  for (const file of result.excluded.files) {
    lines.push(`- excluded \`${file.path}\` [${file.reason}]: ${file.lines.join(', ')}`);
  }
  if (result.offenders.length > 0) {
    lines.push('', 'Uncovered changed lines:');
    for (const file of result.offenders) {
      lines.push(`- \`${file.path}\`: ${file.uncoveredLines.join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function run(argv: readonly string[], cwd?: string): number {
  const values = parseScriptArgs(argv, USAGE, {
    base: { type: 'string', default: 'origin/main' },
  });
  const base = values.base ?? 'origin/main';
  // The `coverage-waiver` PR label sets this env var in CI (and locally).
  const waived = /^(1|true)$/i.test(process.env.AGENT_DEVICE_COVERAGE_WAIVER ?? '');
  const root = cwd ?? runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const lcovPath = path.resolve(root, LCOV_PATH);
  if (!fs.existsSync(lcovPath)) {
    process.stderr.write(
      `check:coverage-changed: no lcov report at ${lcovPath}. Run \`pnpm test:coverage\` first.\n`,
    );
    return 1;
  }

  const diff = runCmdSync(
    'git',
    ['diff', '--unified=0', '--no-color', `--find-renames=${RENAME_SIMILARITY}`, `${base}...HEAD`],
    { cwd: root, maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES },
  ).stdout;
  const result = computeChangedCoverage({
    diffs: parseUnifiedDiff(diff),
    coverage: parseLcov(fs.readFileSync(lcovPath, 'utf8'), root),
    waived,
    fileLines: (relPath) => {
      const abs = path.join(root, relPath);
      return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : null;
    },
  });

  const report = render(result);
  process.stdout.write(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, report);

  return result.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (error: unknown) {
    process.stderr.write(
      `check:coverage-changed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
