// Entry point for the changed-line coverage gate (#1418):
// `pnpm check:coverage-changed [--base <ref>]`.
//
// Reuses the lcov report that `pnpm test:coverage` already produced (never runs
// coverage a second time), joins it with the changed-lines diff against <base>
// (`readChangedLinesDiff`, which pairs renames so a moved file owes only the
// hunks that differ from its source), and fails when changed-line coverage is
// below the threshold. A PR carrying the `coverage-waiver` label skips the
// failure but still prints every number.
// The same markdown report goes to stdout and to the GitHub job summary; it
// includes changed-branch coverage and the count of changed executable lines
// excluded from coverage, both non-gating.
//
// The report is only scored when the stamp beside it proves this checkout
// wrote it: no stamp, a stamp from another commit or another working tree, or
// a narrowed run all refuse with the reason instead of a verdict, the same as
// the CRAP gate. A report whose records name files outside this checkout is
// refused the same way — the stamp cannot catch two checkouts of one commit,
// which share HEAD and bytes. Instrumentation is selected from the verified
// stamp's include/exclude, so the gate and the CRAP gate answer from one
// declaration of what the run measured.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runEntrypoint } from '../lib/cli-entrypoint.ts';
import { parseUnifiedDiff, readChangedLinesDiff } from '../lib/repo-git.ts';
import { computeChangedCoverage, parseLcov, type ChangedCoverageResult } from './model.ts';
import {
  describeStampMismatch,
  findOutsideRootPath,
  verifyCoverageStamp,
} from '../coverage-crap/stamp.ts';

const USAGE = 'Usage: pnpm check:coverage-changed [--base <ref>]\n';
const COVERAGE_DIR = 'coverage';
const LCOV_PATH = 'coverage/lcov.info';

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
  const coverageDir = path.resolve(root, COVERAGE_DIR);
  const lcovPath = path.resolve(root, LCOV_PATH);
  if (!fs.existsSync(lcovPath)) {
    process.stderr.write(
      `check:coverage-changed: no lcov report at ${lcovPath}. Run \`pnpm test:coverage\` first.\n`,
    );
    return 1;
  }

  const coverage = parseLcov(fs.readFileSync(lcovPath, 'utf8'), root);
  // lcov writes its paths absolute, so a report from another root relativizes
  // outside this one and can join none of its files. That must not read as "no
  // file was measured", and the stamp cannot catch it: two checkouts of one
  // commit carry the same HEAD and the same bytes.
  const outside = findOutsideRootPath(coverage.keys());
  if (outside !== undefined) {
    return refuse(
      `${lcovPath} records files outside this checkout, for example ${outside}. ` +
        'It was written by a run in another root; run `pnpm test:coverage` here.',
    );
  }
  // A verdict computed from an unreadable or unattributable report would read
  // as "no findings", which is indistinguishable from a clean branch, so those
  // cases stop here — before the waiver is consulted, which skips a failure
  // rather than blessing a report with no numbers to print.
  const verified = verifyCoverageStamp(coverageDir, root);
  if ('mismatch' in verified) return refuse(describeStampMismatch(verified.mismatch));

  const diff = readChangedLinesDiff(root, base);
  const result = computeChangedCoverage({
    diffs: parseUnifiedDiff(diff),
    coverage,
    stamp: verified.stamp,
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

/**
 * Says out loud that no verdict was reached. These cases exit before a report exists, so they go to
 * stderr rather than heading a table of nothing, which would read as a clean result in the logs.
 */
function refuse(reason: string): number {
  process.stderr.write(`check:coverage-changed: no trustworthy verdict — ${reason}\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runEntrypoint('check:coverage-changed', async () => run(process.argv.slice(2)));
}
