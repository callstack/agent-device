import path from 'node:path';
import type { ReplaySuiteResult, ReplaySuiteTestResult } from '../daemon/types.ts';
import { AppError } from '../kernel/errors.ts';
import type { ReplayTestReporter, ReplayTestReporterContext } from './types.ts';
import {
  appendOptionalLine,
  appendReplayErrorDetails,
  appendReplayErrorMetadata,
  appendReplayTestShardMetadata,
  formatJUnitSeconds,
  formatReplayTestShardSuffix,
  getReplayTestExitCode,
  isFlakyReplayTestResult,
  replayArtifactsLine,
  replayTestCaseName,
  replayTestWarningLines,
  xmlEscape,
  type FailedReplayTestResult,
} from './format.ts';

export function createJunitReplayTestReporter(reportPath: string | undefined): ReplayTestReporter {
  const outputPath = readJunitReportPath(reportPath);
  return {
    name: 'junit',
    onSuiteEnd: (suite, context) => writeReplayJunitReport(outputPath, suite, context),
    getExitCode: getReplayTestExitCode,
  };
}

function readJunitReportPath(reportPath: string | undefined): string {
  if (reportPath && reportPath.trim().length > 0) return reportPath;
  throw new AppError(
    'INVALID_ARGS',
    'The junit test reporter requires an output path. Use --reporter junit:<path>.',
  );
}

function writeReplayJunitReport(
  reportPath: string,
  suite: ReplaySuiteResult,
  context: ReplayTestReporterContext,
): void {
  const directory = path.dirname(reportPath);
  try {
    context.mkdir(directory);
    context.writeFile(reportPath, buildReplayJunitXml(suite));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to write JUnit report to ${reportPath}: ${message}`,
    );
  }
}

function buildReplayJunitXml(suite: ReplaySuiteResult): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites>`,
    `  <testsuite name="agent-device replay suite" tests="${suite.total}" failures="${suite.failed}" skipped="${suite.skipped}" time="${formatJUnitSeconds(suite.durationMs)}">`,
  ];

  for (const test of suite.tests) {
    lines.push(...renderJUnitTestCase(test));
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

function renderJUnitTestCase(test: ReplaySuiteTestResult): string[] {
  const name = xmlEscape(replayTestCaseName(test));
  const className = xmlEscape(
    `${path.dirname(test.file) === '.' ? test.file : path.dirname(test.file)}${formatReplayTestShardSuffix(test)}`,
  );
  const file = xmlEscape(test.file);
  const time = formatJUnitSeconds(test.durationMs);
  const lines = [
    `    <testcase classname="${className}" name="${name}" file="${file}" time="${time}">`,
  ];

  if (test.status === 'failed') {
    lines.push(
      `      <failure message="${xmlEscape(test.error.message)}">${xmlEscape(buildFailureDetails(test))}</failure>`,
    );
  } else if (test.status === 'skipped') {
    lines.push(`      <skipped message="${xmlEscape(test.message)}" />`);
  }

  const systemOut = buildSystemOut(test);
  if (systemOut) {
    lines.push(`      <system-out>${xmlEscape(systemOut)}</system-out>`);
  }

  lines.push('    </testcase>');
  return lines;
}

function buildFailureDetails(test: FailedReplayTestResult): string {
  const lines = [test.error.message];
  appendReplayErrorMetadata(lines, test.error, { includeDetails: false });
  appendOptionalLine(lines, replayArtifactsLine(test, 'artifactsDir'));
  appendReplayErrorDetails(lines, test.error, 2);
  return lines.join('\n');
}

function buildSystemOut(test: ReplaySuiteTestResult): string {
  const lines = [`status: ${test.status}`, `durationMs: ${test.durationMs}`];
  appendReplaySystemOutMetadata(lines, test);
  return lines.join('\n');
}

function appendReplaySystemOutMetadata(lines: string[], test: ReplaySuiteTestResult): void {
  appendOptionalLine(lines, 'attempts' in test ? `attempts: ${test.attempts}` : undefined);
  appendOptionalLine(lines, 'session' in test ? `session: ${test.session}` : undefined);
  appendOptionalLine(lines, 'replayed' in test ? `replayed: ${test.replayed}` : undefined);
  appendOptionalLine(lines, 'healed' in test ? `healed: ${test.healed}` : undefined);
  for (const warning of replayTestWarningLines(test)) {
    lines.push(warning);
  }
  appendOptionalLine(lines, replayArtifactsLine(test, 'artifactsDir'));
  appendReplayTestShardMetadata(lines, test);
  if (test.status === 'failed') {
    appendReplayFailureSystemOut(lines, test);
  }
  appendOptionalLine(lines, isFlakyReplayTestResult(test) ? 'flaky: true' : undefined);
}

function appendReplayFailureSystemOut(lines: string[], test: FailedReplayTestResult): void {
  lines.push(`errorCode: ${test.error.code}`);
  appendReplayErrorMetadata(lines, test.error, { includeMessage: true });
}
