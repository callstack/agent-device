// Renders a whole-bundle XCTest lane's job summary, and asserts the run executed exactly the
// tests the source says that lane reaches.
//
// Two jobs in one place because they read the same file. `xcodebuild` exits 0 when a test
// selection matches nothing, so "green" and "ran no tests" produce the same log tail: a
// build variant missing the unit-test compile flag, an empty test plan, a renamed target,
// or a `-skip-testing:` entry that swallowed the suite would all read as a healthy run.
// Asserting the executed count against `check:xctest-selection`'s reach for the lane
// (`XCTEST_LANE`) is what tells those apart — and it also catches the quieter failure, a
// `#if` guard that compiles a file of tests out of the lane's platform, which "at least one
// test ran" never would.
//
// A script rather than `node -e` in the workflow: this is quoting-sensitive string building
// inside YAML inside shell, and it has a cap to enforce — the job summary is limited to
// 1 MiB, and the run this lane matters most on is the run whose failure list is longest.
//
// Reads `xcrun xcresulttool get test-results summary` JSON (Xcode 16+ shape).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { lane, loadReport, type Lane } from './check-xctest-selection.ts';

/** Failure entries beyond this are counted, not listed. */
export const MAX_LISTED_FAILURES = 60;

/** Each listed failure's message is truncated to this, so one stack cannot dominate. */
export const MAX_FAILURE_TEXT = 300;

type Failure = {
  testName?: string;
  testIdentifierString?: string;
  failureText?: string;
};

export type ResultSummary = {
  result?: string;
  totalTestCount?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  expectedFailures?: number;
  startTime?: number;
  finishTime?: number;
  testFailures?: Failure[];
};

function duration(summary: ResultSummary): string {
  const { startTime, finishTime } = summary;
  if (typeof startTime !== 'number' || typeof finishTime !== 'number') return 'unknown';
  return `${Math.max(0, Math.round(finishTime - startTime))}s`;
}

function failureLine(failure: Failure): string {
  const name = failure.testName ?? failure.testIdentifierString ?? '(unnamed)';
  const text = String(failure.failureText ?? '')
    .replaceAll(/\s+/g, ' ')
    .slice(0, MAX_FAILURE_TEXT);
  return `- \`${name}\`${text ? ` — ${text}` : ''}`;
}

export function renderSummary(summary: ResultSummary, title: string, expected: number): string {
  const failures = Array.isArray(summary.testFailures) ? summary.testFailures : [];
  const shown = failures.slice(0, MAX_LISTED_FAILURES);
  const lines = [
    `### ${title}`,
    '',
    `- result: **${summary.result ?? 'unknown'}**`,
    `- executed: **${summary.totalTestCount ?? 0}** of the ${expected} the source reaches on ` +
      `this lane (passed ${summary.passedTests ?? 0}, failed ${summary.failedTests ?? 0}, ` +
      `skipped ${summary.skippedTests ?? 0}, expected failures ${summary.expectedFailures ?? 0})`,
    `- duration: ${duration(summary)}`,
  ];
  if (shown.length > 0) {
    lines.push('', '#### Failures', ...shown.map(failureLine));
    if (failures.length > shown.length) {
      lines.push(`- …and ${failures.length - shown.length} more; see the uploaded result bundle.`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Null when the run is credible, or the operator-facing reason it is not. */
export function livenessFailure(summary: ResultSummary, expected: number): string | null {
  const executed = summary.totalTestCount ?? 0;
  if (expected < 1) {
    return [
      'check:xctest-selection derives no reachable tests for this lane, so no run can be',
      'credible: the source scan or the lane definition is broken.',
    ].join('\n');
  }
  if (executed === expected) return null;
  if (executed === 0) {
    return [
      `This lane executed no tests (the source says it reaches ${expected}), which xcodebuild`,
      'reports as success. Check AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS (the -D flag that',
      'compiles the tests in), the xctestrun test plan, the target name, and the -skip-testing',
      'entry.',
    ].join('\n');
  }
  return [
    `This lane executed ${executed} test(s) but the source says it reaches ${expected}.`,
    'A `#if` guard compiled tests out of (or into) this platform without the classification',
    'moving with it, or a selection flag matched more or less than it names. Run',
    '`pnpm check:xctest-selection` and compare its per-lane reach with the result bundle.',
  ].join('\n');
}

function main(): number {
  const summaryPath = process.env.RESULT_SUMMARY_PATH;
  if (!summaryPath) throw new Error('RESULT_SUMMARY_PATH is not set.');
  const current: Lane = lane(process.env.XCTEST_LANE ?? '');
  const expected = loadReport().reach[current.id].size;
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as ResultSummary;
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) fs.appendFileSync(stepSummary, renderSummary(summary, current.title, expected));
  process.stdout.write(
    `Executed ${summary.totalTestCount ?? 0} test(s); the source reaches ${expected} on this lane.\n`,
  );
  const failure = livenessFailure(summary, expected);
  if (!failure) return 0;
  process.stderr.write(`${failure}\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
