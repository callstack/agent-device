// Entry point for the changed-line coverage gate (#1418):
// `pnpm check:coverage-changed [--base <ref>]`.
//
// Reuses the lcov report that `pnpm test:coverage` already produced (never runs
// coverage a second time), joins it with `git diff --unified=0 <base>...HEAD`,
// and fails when changed-line coverage is below the threshold. A PR carrying the
// `coverage-waiver` label skips the failure but still prints every number. The
// job summary also reports changed-branch coverage and the count of changed
// executable lines excluded from coverage, both non-gating.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '../../src/utils/exec.ts';
import { parseScriptArgs } from '../lib/cli-args.ts';
import {
  computeChangedCoverage,
  parseLcov,
  parseUnifiedDiff,
  type ChangedCoverageResult,
} from './model.ts';

type Args = { base: string; head: string; lcov: string; json: boolean; waiver: boolean };

const USAGE =
  'Usage: pnpm check:coverage-changed [--base <ref>] [--head <ref>] [--lcov <path>] [--waiver] [--json]\n';

// The `coverage-waiver` PR label sets this in CI (contains(...) on the label
// list). `--waiver` is the local equivalent.
function waiverFromEnv(): boolean {
  return /^(1|true)$/i.test(process.env.AGENT_DEVICE_COVERAGE_WAIVER ?? '');
}

function parseArgs(argv: readonly string[]): Args {
  const values = parseScriptArgs(argv, USAGE, {
    base: { type: 'string', default: 'origin/main' },
    head: { type: 'string', default: 'HEAD' },
    lcov: { type: 'string', default: 'coverage/lcov.info' },
    json: { type: 'boolean', default: false },
    waiver: { type: 'boolean', default: false },
  });
  return {
    base: values.base ?? 'origin/main',
    head: values.head ?? 'HEAD',
    lcov: values.lcov ?? 'coverage/lcov.info',
    json: Boolean(values.json),
    waiver: Boolean(values.waiver) || waiverFromEnv(),
  };
}

function repoRoot(): string {
  return runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
}

function readDiff(base: string, head: string, cwd: string): string {
  return runCmdSync('git', ['diff', '--unified=0', '--no-color', `${base}...${head}`], { cwd })
    .stdout;
}

function fmtPct(pct: number | null): string {
  return pct === null ? 'n/a' : `${pct.toFixed(2)}%`;
}

function renderHuman(result: ChangedCoverageResult): string {
  const lines: string[] = [];
  const verdict = result.waived
    ? 'WAIVED (coverage-waiver label)'
    : result.passed
      ? 'PASS'
      : 'FAIL';
  lines.push(`Changed-line coverage gate: ${verdict}`);
  lines.push(
    `  changed lines covered: ${result.coveredLines}/${result.totalLines} (${fmtPct(result.pct)}), threshold ${result.threshold}%`,
  );
  lines.push(
    `  changed-branch coverage (non-gating): ${result.branch.covered}/${result.branch.total} (${fmtPct(result.branch.pct)})`,
  );
  lines.push(
    `  changed executable lines excluded from coverage (non-gating): ${result.excluded.totalLines}`,
  );
  for (const file of result.excluded.files) {
    lines.push(`    · ${file.path} [${file.reason}]: ${file.lines.join(', ')}`);
  }
  if (result.offenders.length > 0) {
    lines.push('  uncovered changed lines:');
    for (const file of result.offenders) {
      lines.push(`    · ${file.path}: ${file.uncoveredLines.join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderSummaryMarkdown(result: ChangedCoverageResult): string {
  const verdict = result.waived
    ? '⚠️ Waived (`coverage-waiver` label)'
    : result.passed
      ? '✅ Pass'
      : '❌ Fail';
  const rows = [
    '## Changed-line coverage gate',
    '',
    `**${verdict}** — threshold **${result.threshold}%**`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Changed-line coverage (gating) | ${result.coveredLines}/${result.totalLines} (${fmtPct(result.pct)}) |`,
    `| Changed-branch coverage (non-gating) | ${result.branch.covered}/${result.branch.total} (${fmtPct(result.branch.pct)}) |`,
    `| Changed executable lines excluded (non-gating) | ${result.excluded.totalLines} |`,
  ];
  if (result.excluded.files.length > 0) {
    rows.push('', '<details><summary>Excluded changed lines</summary>', '');
    for (const file of result.excluded.files) {
      rows.push(`- \`${file.path}\` [${file.reason}]: ${file.lines.join(', ')}`);
    }
    rows.push('', '</details>');
  }
  if (result.offenders.length > 0) {
    rows.push('', '<details open><summary>Uncovered changed lines</summary>', '');
    for (const file of result.offenders) {
      rows.push(`- \`${file.path}\`: ${file.uncoveredLines.join(', ')}`);
    }
    rows.push('', '</details>');
  }
  return `${rows.join('\n')}\n`;
}

function writeJobSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, markdown);
}

export function run(argv: readonly string[], cwd: string = repoRoot()): number {
  const args = parseArgs(argv);
  const lcovPath = path.isAbsolute(args.lcov) ? args.lcov : path.join(cwd, args.lcov);
  if (!fs.existsSync(lcovPath)) {
    process.stderr.write(
      `check:coverage-changed: no lcov report at ${lcovPath}. Run \`pnpm test:coverage\` first.\n`,
    );
    return 1;
  }

  const coverage = parseLcov(fs.readFileSync(lcovPath, 'utf8'), cwd);
  const diffs = parseUnifiedDiff(readDiff(args.base, args.head, cwd));
  const result = computeChangedCoverage({
    diffs,
    coverage,
    waived: args.waiver,
    fileLines: (relPath) => {
      const abs = path.join(cwd, relPath);
      if (!fs.existsSync(abs)) return null;
      return fs.readFileSync(abs, 'utf8').split('\n');
    },
  });

  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderHuman(result));
  writeJobSummary(renderSummaryMarkdown(result));

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
