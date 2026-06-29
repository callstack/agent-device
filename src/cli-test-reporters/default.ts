import type { ReplaySuiteResult } from '../daemon/types.ts';
import { replayTestFailureStepLines } from '../cli-test-trace.ts';
import { formatDurationSeconds } from '../utils/duration-format.ts';
import { colorize, supportsColor } from '../utils/output.ts';
import type { ReplayTestReporter } from './types.ts';
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
  type FailedReplayTestResult,
  type PassedReplayTestResult,
} from './format.ts';

export function createDefaultReplayTestReporter(): ReplayTestReporter {
  return {
    name: 'default',
    onSuiteEnd: (suite, context) => renderReplayTestSummary(suite, { debug: context.debug }),
    getExitCode: getReplayTestExitCode,
  };
}

function renderReplayTestSummary(data: ReplaySuiteResult, options: { debug?: boolean } = {}): void {
  const flaky = data.tests.filter(isFlakyReplayTestResult);
  process.stdout.write(`${formatReplayTestSummaryLine(data, flaky.length)}\n`);
  renderFailureDetails(data.tests.filter(isFailedReplayTestResult), { debug: options.debug });
  renderFlakyTestSummary(flaky);
}

function formatReplayTestSummaryLine(data: ReplaySuiteResult, flakyCount: number): string {
  const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined;
  const flakySuffix = flakyCount > 0 ? `, ${flakyCount} flaky` : '';
  const durationSuffix = durationMs !== undefined ? ` in ${formatDurationSeconds(durationMs)}` : '';
  return `Test summary: ${data.passed} passed, ${data.failed} failed${flakySuffix}${durationSuffix}`;
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

function renderFlakyTestSummary(results: PassedReplayTestResult[]): void {
  if (results.length === 0) return;
  process.stdout.write('\n');
  process.stdout.write('Flaky tests:\n');
  for (const result of results) {
    process.stdout.write(
      `  ${replayFlakyStatusIcon()} ${replayTestDisplayNameWithFile(result)} after ${result.attempts} attempts${formatFlakyReplayDurationSuffix(result)}\n`,
    );
    for (const failure of result.attemptFailures ?? []) {
      const attemptDuration =
        typeof failure.durationMs === 'number'
          ? ` (${formatDurationSeconds(failure.durationMs)})`
          : '';
      process.stdout.write(
        `    attempt ${failure.attempt} failed${attemptDuration}: ${failure.message}\n`,
      );
    }
  }
}

function renderFailureDetails(
  results: FailedReplayTestResult[],
  options: { debug?: boolean } = {},
): void {
  if (results.length === 0) return;
  process.stdout.write('\n');
  process.stdout.write('Failures:\n');
  for (const result of results) {
    process.stdout.write(`  ${replayTestDisplayNameWithFile(result)}\n`);
    renderReplayFailureBody(result, { debug: options.debug, indent: '    ' });
  }
}

function renderReplayFailureBody(
  result: FailedReplayTestResult,
  options: { debug?: boolean; indent: string },
): void {
  const { debug, indent } = options;
  process.stdout.write(`${indent}${result.error?.message ?? 'Unknown test failure'}\n`);
  for (const line of replayFailureConsoleLines(result)) {
    process.stdout.write(`${indent}${line}\n`);
  }
  if (!debug) return;
  for (const line of replayTestFailureStepLines(result)) {
    process.stdout.write(`${indent}${line}\n`);
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
