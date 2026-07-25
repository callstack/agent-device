import path from 'node:path';
import { replayTestStepLines } from './trace.ts';
import type { ReplaySuiteTestResult } from '../../contracts/replay.ts';
import type {
  ReplayTestReporterProgressEvent,
  ReplayTestResult,
  ReplayTestStep,
} from './reporters/types.ts';
import { formatCliStatusMarker } from '../../contracts/cli-status-markers.ts';
import { formatDurationSeconds } from '../../utils/duration-format.ts';
import { colorize, supportsColor } from '../../utils/output.ts';

export type ReplayTestProgressFormatOptions = {
  verbose?: boolean;
  liveProgress?: boolean;
  columns?: number;
};

export type ReplayTestProgressRender = {
  text: string;
  newline: boolean;
};

export type ReplayTestProgressRenderer = {
  render(event: ReplayTestReporterProgressEvent): ReplayTestProgressRender | undefined;
};

const REPLAY_TEST_PROGRESS_SPINNER = {
  interval: 80,
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};
const ANSI_ESCAPE_PREFIX = `${String.fromCharCode(27)}[`;
const ANSI_RESET = `${ANSI_ESCAPE_PREFIX}0m`;

export const REPLAY_TEST_PROGRESS_SPINNER_INTERVAL_MS = REPLAY_TEST_PROGRESS_SPINNER.interval;

export function createReplayTestProgressRenderer(
  options: ReplayTestProgressFormatOptions = {},
): ReplayTestProgressRenderer {
  const completedKeys = new Set<string>();
  let hasLiveProgressLine = false;
  let spinnerFrameIndex = 0;
  return {
    render(event) {
      if (event.type === 'suite-start') {
        completedKeys.clear();
        hasLiveProgressLine = false;
        return undefined;
      }
      if (event.type === 'test-step') {
        if (!options.liveProgress) return undefined;
        hasLiveProgressLine = true;
        const spinnerFrame = nextReplayTestProgressSpinnerFrame(spinnerFrameIndex);
        spinnerFrameIndex += 1;
        return {
          text: clearLinePrefix(
            formatReplayTestLiveProgressLine(event.test, options, spinnerFrame),
          ),
          newline: false,
        };
      }
      if (event.type !== 'test-result') return undefined;
      if (isReplayTestCompletionProgressEvent(event.test)) {
        const key = replayTestCompletionProgressKey(event.test);
        if (completedKeys.has(key)) return undefined;
        completedKeys.add(key);
      }
      const line = formatReplayTestProgressEvent(event.test, options);
      if (!line) return undefined;
      const text = hasLiveProgressLine ? clearLinePrefix(line) : line;
      hasLiveProgressLine = false;
      return { text, newline: true };
    },
  };
}

function nextReplayTestProgressSpinnerFrame(index: number): string {
  return (
    REPLAY_TEST_PROGRESS_SPINNER.frames[index % REPLAY_TEST_PROGRESS_SPINNER.frames.length] ??
    REPLAY_TEST_PROGRESS_SPINNER.frames[0]!
  );
}

function formatReplayTestProgressEvent(
  event: ReplayTestResult,
  options: ReplayTestProgressFormatOptions = {},
): string | undefined {
  if (event.status === 'fail' && event.retrying) return undefined;
  const lines = [formatReplayTestCaseSummaryLine(event)];
  addReplayTestCaseDetailLines(lines, event, options);
  if (options.verbose) {
    lines.push(...replayTestProgressStepLines(event));
  }
  return lines.join('\n');
}

function formatReplayTestLiveProgressLine(
  event: ReplayTestStep,
  options: ReplayTestProgressFormatOptions,
  spinnerFrame: string,
): string {
  const title = event.title?.trim();
  const file = path.basename(event.file);
  const useColor = supportsColor(process.stderr);
  const spinner = formatReplayTestProgressSpinner(spinnerFrame, { useColor });
  const shardSuffix = formatReplayTestProgressShardSuffix(event, { useColor });
  const stepSuffix = formatReplayTestLiveProgressStepSuffix(event, { useColor });
  const suffix = `${shardSuffix}${stepSuffix}`;
  const prefix = `${spinner} `;
  if (!title) return trimToColumns(`${prefix}${file}${suffix}`, options.columns);

  const availableTitleColumns = Math.max(
    0,
    resolveColumns(options.columns) - visibleLength(prefix) - visibleLength(suffix),
  );
  const formattedTitle = trimToColumns(title, availableTitleColumns);
  return trimToColumns(`${prefix}${formattedTitle}${suffix}`, options.columns);
}

function formatReplayTestProgressSpinner(
  frame: string,
  options: { useColor?: boolean } = {},
): string {
  return options.useColor ? colorizeProgressMarker(frame, 'blue') : frame;
}

function formatReplayTestLiveProgressStepSuffix(
  event: ReplayTestStep,
  options: { useColor?: boolean } = {},
): string {
  const stepIndex = event.stepIndex ?? 0;
  const stepTotal = event.stepTotal ?? 0;
  const stepMarker = `${stepIndex}/${stepTotal}`;
  const command = event.stepCommand?.trim();
  const value = event.stepValue?.trim();
  if (!options.useColor) {
    const details = [stepMarker, command, value].filter(Boolean).join(' ');
    return ` [${details}]`;
  }
  const openBracket = colorizeProgressMarker('[', 'dim');
  const closeBracket = colorizeProgressMarker(']', 'dim');
  const details = [
    colorizeProgressMarker(stepMarker, 'dim'),
    command ? colorizeProgressMarker(command, 'magenta') : '',
    value ? colorizeProgressMarker(value, 'green') : '',
  ].filter(Boolean);
  return ` ${openBracket}${details.join(' ')}${closeBracket}`;
}

function addReplayTestCaseDetailLines(
  lines: string[],
  event: ReplayTestResult,
  options: ReplayTestProgressFormatOptions,
): void {
  if (shouldSuppressReplayTestCaseDetailLines(event, options)) return;
  const fileLine = replayTestProgressFailureFileLine(event);
  const messageLine = replayTestProgressMessageLine(event);
  if (fileLine) lines.push(fileLine);
  if (messageLine) lines.push(messageLine);
  appendReplayTestProgressHintLine(lines, event);
  lines.push(...replayTestProgressFailureContextLines(event));
}

function shouldSuppressReplayTestCaseDetailLines(
  event: ReplayTestResult,
  options: ReplayTestProgressFormatOptions,
): boolean {
  return options.verbose === true && event.status === 'fail';
}

function replayTestProgressFailureFileLine(event: ReplayTestResult): string | undefined {
  return event.status === 'fail' && event.title?.trim()
    ? `    file: ${path.basename(event.file)}`
    : undefined;
}

function replayTestProgressMessageLine(event: ReplayTestResult): string | undefined {
  const message = event.message?.replace(/\s+/g, ' ').trim();
  if (!message) return undefined;
  return `    ${event.status === 'fail' ? `failed at: ${message}` : message}`;
}

function appendReplayTestProgressHintLine(lines: string[], event: ReplayTestResult): void {
  const hint = event.hint?.replace(/\s+/g, ' ').trim();
  if (event.status === 'fail' && hint) lines.push(`    hint: ${hint}`);
}

function replayTestProgressFailureContextLines(event: ReplayTestResult): string[] {
  if (event.status !== 'fail' || event.retrying) return [];
  const lines: string[] = [];
  if (event.session) lines.push(`    session: ${event.session}`);
  if (event.artifactsDir) lines.push(`    artifacts: ${event.artifactsDir}`);
  return lines;
}

function formatReplayTestCaseSummaryLine(event: ReplayTestResult): string {
  const useColor = supportsColor(process.stderr);
  const statusLabel = formatReplayTestProgressStatusLabel(event);
  const name = formatReplayTestProgressName(event);
  const shardSuffix = formatReplayTestProgressShardSuffix(event, { useColor });
  const durationSuffix =
    event.durationMs !== undefined ? ` ${formatReplayProgressDuration(event, { useColor })}` : '';
  return `${statusLabel} ${name}${shardSuffix}${durationSuffix}`;
}

function formatReplayTestProgressName(event: ReplayTestResult | ReplayTestStep): string {
  const title = event.title?.trim();
  const file = path.basename(event.file);
  return title ? title : file;
}

function formatReplayTestProgressStatusLabel(event: ReplayTestResult): string {
  if (event.status === 'pass') {
    return formatCliStatusMarker('pass', {
      passFormat: event.attempt && event.attempt > 1 ? 'yellow' : 'green',
    });
  }
  return formatCliStatusMarker(event.status === 'fail' ? 'fail' : 'skip');
}

function colorizeProgressMarker(text: string, format: Parameters<typeof colorize>[1]): string {
  return colorize(text, format, { validateStream: false });
}

function formatReplayTestProgressShardSuffix(
  event: ReplayTestResult | ReplayTestStep,
  options: { useColor?: boolean } = {},
): string {
  if (typeof event.shardIndex !== 'number') return '';
  const shardCount = typeof event.shardCount === 'number' ? event.shardCount : '?';
  const device = replayTestProgressShardDeviceName(event);
  const suffix = ` [${event.shardIndex + 1}/${shardCount}${device ? ` ${device}` : ''}]`;
  return options.useColor ? colorizeProgressMarker(suffix, 'dim') : suffix;
}

function replayTestProgressShardDeviceName(
  event: ReplayTestResult | ReplayTestStep,
): string | undefined {
  const name = event.deviceName?.trim();
  if (name) return name;
  const id = event.deviceId?.trim();
  return id || undefined;
}

function formatReplayProgressDuration(
  event: ReplayTestResult,
  options: { useColor?: boolean } = {},
): string {
  const duration = formatDurationSeconds(event.durationMs ?? 0);
  return options.useColor ? colorizeProgressMarker(duration, 'yellow') : duration;
}

function isReplayTestCompletionProgressEvent(event: ReplayTestResult): boolean {
  return (
    event.status === 'pass' ||
    event.status === 'skip' ||
    (event.status === 'fail' && !event.retrying)
  );
}

function replayTestCompletionProgressKey(event: ReplayTestResult): string {
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
  if (visibleLength(value) <= limit) return value;
  if (limit <= 0) return '';
  if (limit <= 3) return '.'.repeat(limit);
  return `${sliceVisibleColumns(value, limit - 3)}...${hasAnsi(value) ? ANSI_RESET : ''}`;
}

function visibleLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; ) {
    const ansi = readAnsiEscapeAt(value, index);
    if (ansi) {
      index += ansi.length;
      continue;
    }
    length += 1;
    index += 1;
  }
  return length;
}

function hasAnsi(value: string): boolean {
  return value.includes(ANSI_ESCAPE_PREFIX);
}

function sliceVisibleColumns(value: string, columns: number): string {
  if (columns <= 0) return '';
  let visibleColumns = 0;
  let output = '';
  for (let index = 0; index < value.length && visibleColumns < columns; ) {
    const ansi = readAnsiEscapeAt(value, index);
    if (ansi) {
      output += ansi;
      index += ansi.length;
      continue;
    }
    output += value[index];
    index += 1;
    visibleColumns += 1;
  }
  return output;
}

function readAnsiEscapeAt(value: string, index: number): string | null {
  if (!value.startsWith(ANSI_ESCAPE_PREFIX, index)) return null;
  for (let cursor = index + ANSI_ESCAPE_PREFIX.length; cursor < value.length; cursor += 1) {
    if (isAnsiFinalByte(value.charCodeAt(cursor))) return value.slice(index, cursor + 1);
  }
  return null;
}

function isAnsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function replayTestProgressStepLines(event: ReplayTestResult): string[] {
  if (event.status !== 'pass' && event.status !== 'fail') return [];
  if (!event.artifactsDir || !event.attempt) return [];
  const result =
    event.status === 'pass'
      ? buildPassedReplayTestProgressResult(event)
      : buildFailedReplayTestProgressResult(event);
  return replayTestStepLines(result).map((line) => `    ${line}`);
}

function buildPassedReplayTestProgressResult(
  event: ReplayTestResult,
): Extract<ReplaySuiteTestResult, { status: 'passed' }> {
  return {
    ...replayTestProgressResultBase(event),
    status: 'passed',
    replayed: 0,
    healed: 0,
  };
}

function buildFailedReplayTestProgressResult(
  event: ReplayTestResult,
): Extract<ReplaySuiteTestResult, { status: 'failed' }> {
  return {
    ...replayTestProgressResultBase(event),
    status: 'failed',
    error: { code: 'COMMAND_FAILED', message: event.message ?? 'Unknown test failure' },
  };
}

function replayTestProgressResultBase(event: ReplayTestResult) {
  return {
    file: event.file,
    title: event.title,
    durationMs: event.durationMs ?? 0,
    attempts: event.attempt ?? 1,
    artifactsDir: event.artifactsDir,
    session: event.session ?? '',
  };
}
