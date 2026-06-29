import type { ReplaySuiteResult } from '../daemon/types.ts';
import { replayTestFailureStepLines } from '../cli-test-trace.ts';
import { formatDurationSeconds } from '../utils/duration-format.ts';
import { colorize, supportsColor } from '../utils/output.ts';
import type { ReplayTestReporter, ReplayTestReporterContext } from './types.ts';
import {
  getReplayTestExitCode,
  isDefinedString,
  isFailedReplayTestResult,
  isFlakyReplayTestResult,
  replayArtifactsLine,
  replayErrorDiagnosticLine,
  replayErrorHintLine,
  replayErrorLogLine,
  replayTestDisplayNameWithFile,
  replayTestFailureFileLine,
  type FailedReplayTestResult,
  type PassedReplayTestResult,
} from './format.ts';

export function createDefaultReplayTestReporter(): ReplayTestReporter {
  return {
    name: 'default',
    onSuiteEnd: (suite, context) => renderReplayTestSummary(suite, context),
    getExitCode: getReplayTestExitCode,
  };
}

function renderReplayTestSummary(
  data: ReplaySuiteResult,
  context: ReplayTestReporterContext,
): void {
  const flaky = data.tests.filter(isFlakyReplayTestResult);
  context.writeStdout(`${formatReplayTestSummaryLine(data, flaky.length)}\n`);
  renderFailureDetails(data.tests.filter(isFailedReplayTestResult), context);
  renderFlakyTestSummary(flaky, context);
}

function formatReplayTestSummaryLine(data: ReplaySuiteResult, flakyCount: number): string {
  const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined;
  const useColor = supportsColor();
  const passed = formatReplaySummaryPassed(data.passed, { useColor });
  const total = formatReplaySummaryTotal(data.total, { useColor });
  const failedSuffix = data.failed > 0 ? `, ${data.failed} failed` : '';
  const flakySuffix = flakyCount > 0 ? `, ${flakyCount} flaky` : '';
  const durationSuffix =
    durationMs !== undefined ? ` in ${formatReplayDuration(durationMs, { useColor })}` : '';
  return `Test summary: ${passed} ${total}${failedSuffix}${flakySuffix}${durationSuffix}`;
}

function formatReplaySummaryPassed(passed: number, options: { useColor?: boolean } = {}): string {
  const text = `${passed} passed`;
  return options.useColor ? colorize(text, 'green') : text;
}

function formatReplaySummaryTotal(total: number, options: { useColor?: boolean } = {}): string {
  const text = `(${total})`;
  return options.useColor ? colorize(text, 'dim') : text;
}

function formatReplayDuration(durationMs: number, options: { useColor?: boolean } = {}): string {
  const duration = formatDurationSeconds(durationMs);
  return options.useColor ? colorize(duration, 'yellow') : duration;
}

function replayFlakyStatusIcon(): string {
  const useColor = supportsColor();
  return useColor ? colorize('✓', 'yellow') : '✓';
}

function replayFailureConsoleLines(result: FailedReplayTestResult): string[] {
  return [
    replayErrorHintLine(result.error),
    replayArtifactsLine(result, 'artifacts'),
    replayErrorLogLine(result.error, 'log'),
    replayErrorDiagnosticLine(result.error, 'diagnostic'),
  ].filter(isDefinedString);
}

function renderFlakyTestSummary(
  results: PassedReplayTestResult[],
  context: ReplayTestReporterContext,
): void {
  if (results.length === 0) return;
  context.writeStdout('\n');
  context.writeStdout('Flaky tests:\n');
  for (const result of results) {
    context.writeStdout(
      `  ${replayFlakyStatusIcon()} ${replayTestDisplayNameWithFile(result)} after ${result.attempts} attempts${formatFlakyReplayDurationSuffix(result)}\n`,
    );
    for (const failure of result.attemptFailures ?? []) {
      const attemptDuration =
        typeof failure.durationMs === 'number'
          ? ` (${formatDurationSeconds(failure.durationMs)})`
          : '';
      context.writeStdout(
        `    attempt ${failure.attempt} failed${attemptDuration}: ${failure.message}\n`,
      );
    }
  }
}

function renderFailureDetails(
  results: FailedReplayTestResult[],
  context: ReplayTestReporterContext,
): void {
  if (results.length === 0) return;
  context.writeStdout('\n');
  context.writeStdout('Failures:\n');
  for (const result of results) {
    context.writeStdout(`  ${replayTestDisplayNameWithFile(result)}\n`);
    renderReplayFailureBody(result, context, '    ');
  }
}

function renderReplayFailureBody(
  result: FailedReplayTestResult,
  context: ReplayTestReporterContext,
  indent: string,
): void {
  const fileLine = replayTestFailureFileLine(result);
  if (fileLine) context.writeStdout(`${indent}${fileLine}\n`);
  context.writeStdout(`${indent}${result.error?.message ?? 'Unknown test failure'}\n`);
  for (const line of replayFailureConsoleLines(result)) {
    context.writeStdout(`${indent}${line}\n`);
  }
  if (!context.debug) return;
  for (const line of replayTestFailureStepLines(result)) {
    context.writeStdout(`${indent}${line}\n`);
  }
}

function formatFlakyReplayDurationSuffix(result: PassedReplayTestResult): string {
  const timings = [
    typeof result.finalAttemptDurationMs === 'number'
      ? `passed attempt ${formatDurationSeconds(result.finalAttemptDurationMs)}`
      : '',
    result.durationMs > 0 ? `total ${formatDurationSeconds(result.durationMs)}` : '',
  ].filter(Boolean);
  return timings.length > 0 ? ` (${timings.join(', ')})` : '';
}
