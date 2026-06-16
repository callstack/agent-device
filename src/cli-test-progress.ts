import path from 'node:path';
import type { RequestProgressEvent } from './daemon/request-progress.ts';
import { replayTestStepLines } from './cli-test-trace.ts';
import type { ReplaySuiteTestResult } from './daemon/types.ts';
import { formatDurationSeconds } from './utils/duration-format.ts';
import { colorize, supportsColor } from './utils/output.ts';

type ReplayTestCaseProgressEvent = Extract<RequestProgressEvent, { type: 'replay-test' }>;
type ReplayTestProgressFormatOptions = {
  verbose?: boolean;
  liveProgress?: boolean;
  columns?: number;
};

export type ReplayTestProgressRender = {
  text: string;
  newline: boolean;
};

export type ReplayTestProgressRenderer = {
  render(event: RequestProgressEvent): ReplayTestProgressRender | undefined;
};

export function createReplayTestProgressRenderer(
  options: ReplayTestProgressFormatOptions = {},
): ReplayTestProgressRenderer {
  const completedKeys = new Set<string>();
  let hasLiveProgressLine = false;
  return {
    render(event) {
      if (event.type === 'replay-test-suite') {
        completedKeys.clear();
        hasLiveProgressLine = false;
        return undefined;
      }
      if (event.type !== 'replay-test') {
        return undefined;
      }
      if (event.status === 'progress') {
        if (!options.liveProgress) return undefined;
        hasLiveProgressLine = true;
        return {
          text: clearLinePrefix(formatReplayTestLiveProgressLine(event, options)),
          newline: false,
        };
      }
      if (isReplayTestCompletionProgressEvent(event)) {
        const key = replayTestCompletionProgressKey(event);
        if (completedKeys.has(key)) return undefined;
        completedKeys.add(key);
      }
      const line = formatReplayTestProgressEvent(event, options);
      if (!line) return undefined;
      const text = hasLiveProgressLine ? clearLinePrefix(line) : line;
      hasLiveProgressLine = false;
      return { text, newline: true };
    },
  };
}

export function formatReplayTestProgressEvent(
  event: RequestProgressEvent,
  options: ReplayTestProgressFormatOptions = {},
): string | undefined {
  if (event.type !== 'replay-test') {
    return undefined;
  }
  return formatReplayTestCaseProgressEvent(event, options);
}

function formatReplayTestCaseProgressEvent(
  event: ReplayTestCaseProgressEvent,
  options: ReplayTestProgressFormatOptions,
): string | undefined {
  if (event.status === 'start' || event.status === 'progress') return undefined;
  if (event.status === 'fail' && event.retrying) return undefined;
  const lines = [formatReplayTestCaseSummaryLine(event)];
  addReplayTestCaseDetailLines(lines, event, options);
  if (options.verbose) {
    lines.push(...replayTestProgressStepLines(event));
  }
  return lines.join('\n');
}

function formatReplayTestLiveProgressLine(
  event: ReplayTestCaseProgressEvent,
  options: ReplayTestProgressFormatOptions,
): string {
  const title = event.title?.trim();
  const file = path.basename(event.file);
  const shardSuffix = formatReplayTestProgressShardSuffix(event);
  const stepIndex = event.stepIndex ?? 0;
  const stepTotal = event.stepTotal ?? 0;
  const suffix = `${shardSuffix} [${stepIndex}/${stepTotal}]`;
  const prefix = '⊙ ';
  if (!title) return trimToColumns(`${prefix}${file}${suffix}`, options.columns);

  const titlePrefix = `${prefix}"`;
  const titleSuffix = `" in ${file}${suffix}`;
  const availableTitleColumns = Math.max(
    0,
    resolveColumns(options.columns) - titlePrefix.length - titleSuffix.length,
  );
  const formattedTitle = trimToColumns(title, availableTitleColumns);
  return trimToColumns(`${titlePrefix}${formattedTitle}${titleSuffix}`, options.columns);
}

function addReplayTestCaseDetailLines(
  lines: string[],
  event: ReplayTestCaseProgressEvent,
  options: ReplayTestProgressFormatOptions,
): void {
  if (options.verbose && event.status === 'fail') return;
  const message = event.message?.replace(/\s+/g, ' ').trim();
  if (message) {
    lines.push(`    ${event.status === 'fail' ? `failed at: ${message}` : message}`);
  }
  if (event.status === 'fail' && !event.retrying) {
    if (event.session) lines.push(`    session: ${event.session}`);
    if (event.artifactsDir) lines.push(`    artifacts: ${event.artifactsDir}`);
  }
}

function formatReplayTestCaseSummaryLine(event: ReplayTestCaseProgressEvent): string {
  const statusLabel = formatReplayTestProgressStatusLabel(event);
  const name = formatReplayTestProgressName(event);
  const shardSuffix = formatReplayTestProgressShardSuffix(event);
  const durationSuffix =
    event.durationMs !== undefined ? ` (${formatReplayProgressDuration(event)})` : '';
  return `${statusLabel} ${name}${shardSuffix}${durationSuffix}`;
}

function formatReplayTestProgressName(event: ReplayTestCaseProgressEvent): string {
  const title = event.title?.trim();
  const file = path.basename(event.file);
  return title ? `${JSON.stringify(title)} in ${file}` : file;
}

function formatReplayTestProgressStatusLabel(event: ReplayTestCaseProgressEvent): string {
  const useColor = supportsColor(process.stderr);
  if (event.status === 'pass') {
    const format = event.attempt && event.attempt > 1 ? 'yellow' : 'green';
    return useColor ? colorizeProgressMarker('✓', format) : '✓';
  }
  if (event.status === 'fail') return useColor ? colorizeProgressMarker('⨯', 'red') : '⨯';
  if (event.status === 'progress') return '⊙';
  return useColor ? colorizeProgressMarker('-', 'dim') : '-';
}

function colorizeProgressMarker(text: string, format: Parameters<typeof colorize>[1]): string {
  return colorize(text, format, { validateStream: false });
}

function formatReplayTestProgressShardSuffix(event: ReplayTestCaseProgressEvent): string {
  if (typeof event.shardIndex !== 'number') return '';
  const shardCount = typeof event.shardCount === 'number' ? event.shardCount : '?';
  const device = typeof event.deviceId === 'string' ? ` ${event.deviceId}` : '';
  return ` [shard ${event.shardIndex + 1}/${shardCount}${device}]`;
}

function formatReplayProgressDuration(event: ReplayTestCaseProgressEvent): string {
  return formatDurationSeconds(event.durationMs ?? 0);
}

function isReplayTestCompletionProgressEvent(event: ReplayTestCaseProgressEvent): boolean {
  return (
    event.status === 'pass' ||
    event.status === 'skip' ||
    (event.status === 'fail' && !event.retrying)
  );
}

function replayTestCompletionProgressKey(event: ReplayTestCaseProgressEvent): string {
  const shard = typeof event.shardIndex === 'number' ? event.shardIndex : '';
  return [event.status, event.index, event.total, event.file, event.title ?? '', shard].join('\0');
}

function clearLinePrefix(text: string): string {
  return `\r\x1B[2K${text}`;
}

function resolveColumns(columns: number | undefined): number {
  return typeof columns === 'number' && Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : 80;
}

function trimToColumns(value: string, columns: number | undefined): string {
  const limit = resolveColumns(columns);
  if (value.length <= limit) return value;
  if (limit <= 0) return '';
  if (limit <= 3) return '.'.repeat(limit);
  return `${value.slice(0, limit - 3)}...`;
}

function replayTestProgressStepLines(event: ReplayTestCaseProgressEvent): string[] {
  if (event.status !== 'pass' && event.status !== 'fail') return [];
  if (!event.artifactsDir || !event.attempt) return [];
  const result =
    event.status === 'pass'
      ? buildPassedReplayTestProgressResult(event)
      : buildFailedReplayTestProgressResult(event);
  return replayTestStepLines(result).map((line) => `    ${line}`);
}

function buildPassedReplayTestProgressResult(
  event: ReplayTestCaseProgressEvent,
): Extract<ReplaySuiteTestResult, { status: 'passed' }> {
  return {
    ...replayTestProgressResultBase(event),
    status: 'passed',
    replayed: 0,
    healed: 0,
  };
}

function buildFailedReplayTestProgressResult(
  event: ReplayTestCaseProgressEvent,
): Extract<ReplaySuiteTestResult, { status: 'failed' }> {
  return {
    ...replayTestProgressResultBase(event),
    status: 'failed',
    error: { code: 'COMMAND_FAILED', message: event.message ?? 'Unknown test failure' },
  };
}

function replayTestProgressResultBase(event: ReplayTestCaseProgressEvent) {
  return {
    file: event.file,
    title: event.title,
    durationMs: event.durationMs ?? 0,
    attempts: event.attempt ?? 1,
    artifactsDir: event.artifactsDir,
    session: event.session ?? '',
  };
}
