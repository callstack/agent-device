import type { ReplaySuiteResult } from '../../../daemon/types.ts';
import { replayTestFailureStepLines } from '../trace.ts';
import {
  createReplayTestProgressRenderer,
  REPLAY_TEST_PROGRESS_SPINNER_INTERVAL_MS,
} from '../progress.ts';
import { formatDurationSeconds } from '../../../utils/duration-format.ts';
import { colorize, supportsColor } from '../../../utils/output.ts';
import { formatReplayDivergenceReport } from '../../divergence.ts';
import type {
  ReplayTestReporter,
  ReplayTestReporterContext,
  ReplayTestReporterProgressEvent,
} from './types.ts';
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

const ANSI_ESCAPE_PREFIX = `${String.fromCharCode(27)}[`;
const HIDE_CURSOR = `${ANSI_ESCAPE_PREFIX}?25l`;
const SHOW_CURSOR = `${ANSI_ESCAPE_PREFIX}?25h`;

export function createDefaultReplayTestReporter(): ReplayTestReporter {
  let progressRenderer: ReturnType<typeof createReplayTestProgressRenderer> | undefined;
  let latestLiveProgressEvent: ReplayTestReporterProgressEvent | undefined;
  let progressInterval: ReturnType<typeof setInterval> | undefined;
  let cursorHidden = false;
  const renderProgress = (
    event: ReplayTestReporterProgressEvent,
    context: ReplayTestReporterContext,
  ) => {
    stopLiveProgressInterval();
    latestLiveProgressEvent = event.type === 'test-step' ? event : undefined;
    progressRenderer ??= createReplayTestProgressRenderer({
      verbose: context.verbose,
      liveProgress: shouldUseLiveProgress(context),
      columns: context.stderr.columns,
    });
    const output = progressRenderer.render(event);
    if (!output) return;
    context.stderr.write(output.newline ? `${output.text}\n` : output.text);
    if (event.type === 'test-step' && shouldUseLiveProgress(context)) {
      startLiveProgressInterval(context);
    }
  };
  const startLiveProgressInterval = (context: ReplayTestReporterContext) => {
    if (progressInterval || !latestLiveProgressEvent) return;
    progressInterval = setInterval(() => {
      if (!latestLiveProgressEvent) return;
      const output = progressRenderer?.render(latestLiveProgressEvent);
      if (output) context.stderr.write(output.newline ? `${output.text}\n` : output.text);
    }, REPLAY_TEST_PROGRESS_SPINNER_INTERVAL_MS);
    progressInterval.unref?.();
  };
  const stopLiveProgressInterval = () => {
    if (!progressInterval) return;
    clearInterval(progressInterval);
    progressInterval = undefined;
  };
  const hideCursor = (context: ReplayTestReporterContext) => {
    if (cursorHidden || !shouldUseLiveProgress(context)) return;
    context.stderr.write(HIDE_CURSOR);
    cursorHidden = true;
  };
  const showCursor = (context: ReplayTestReporterContext) => {
    if (!cursorHidden) return;
    context.stderr.write(SHOW_CURSOR);
    cursorHidden = false;
  };
  return {
    name: 'default',
    onSuiteStart: (suite, context) => {
      hideCursor(context);
      renderProgress({ type: 'suite-start', suite }, context);
    },
    onTestStep: (test, context) => {
      renderProgress({ type: 'test-step', test }, context);
    },
    onTestResult: (test, context) => {
      renderProgress({ type: 'test-result', test }, context);
    },
    onSuiteEnd: (suite, context) => {
      stopLiveProgressInterval();
      latestLiveProgressEvent = undefined;
      showCursor(context);
      renderReplayTestSummary(suite, context);
    },
    getExitCode: getReplayTestExitCode,
  };
}

function shouldUseLiveProgress(context: ReplayTestReporterContext): boolean {
  return context.stderr.isTTY && !process.env.CI;
}

function renderReplayTestSummary(
  data: ReplaySuiteResult,
  context: ReplayTestReporterContext,
): void {
  const flaky = data.tests.filter(isFlakyReplayTestResult);
  context.stdout.write(`${formatReplayTestSummaryLine(data, flaky.length)}\n`);
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
  context.stdout.write('\n');
  context.stdout.write('Flaky tests:\n');
  for (const result of results) {
    context.stdout.write(
      `  ${replayFlakyStatusIcon()} ${replayTestDisplayNameWithFile(result)} after ${result.attempts} attempts${formatFlakyReplayDurationSuffix(result)}\n`,
    );
    for (const failure of result.attemptFailures ?? []) {
      const attemptDuration =
        typeof failure.durationMs === 'number'
          ? ` (${formatDurationSeconds(failure.durationMs)})`
          : '';
      context.stdout.write(
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
  context.stdout.write('\n');
  context.stdout.write('Failures:\n');
  for (const result of results) {
    context.stdout.write(`  ${replayTestDisplayNameWithFile(result)}\n`);
    renderReplayFailureBody(result, context, '    ');
  }
}

function renderReplayFailureBody(
  result: FailedReplayTestResult,
  context: ReplayTestReporterContext,
  indent: string,
): void {
  const fileLine = replayTestFailureFileLine(result);
  if (fileLine) context.stdout.write(`${indent}${fileLine}\n`);
  context.stdout.write(`${indent}${result.error?.message ?? 'Unknown test failure'}\n`);
  for (const line of replayFailureConsoleLines(result)) {
    context.stdout.write(`${indent}${line}\n`);
  }
  renderReplayFailureDivergence(result, context, indent);
  if (!context.debug) return;
  for (const line of replayTestFailureStepLines(result)) {
    context.stdout.write(`${indent}${line}\n`);
  }
}

// ADR 0012: the `test` text surface carries the divergence repair data
// (screen refs / suggestions), same as the --json suite payload.
function renderReplayFailureDivergence(
  result: FailedReplayTestResult,
  context: ReplayTestReporterContext,
  indent: string,
): void {
  const divergence = formatReplayDivergenceReport(result.error?.details);
  if (!divergence) return;
  for (const line of divergence.split('\n')) {
    context.stdout.write(`${indent}${line}\n`);
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
