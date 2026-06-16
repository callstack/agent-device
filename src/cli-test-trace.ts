import fs from 'node:fs';
import path from 'node:path';
import type { ReplaySuiteTestResult } from './daemon/types.ts';
import { formatDurationSeconds } from './utils/duration-format.ts';

type ReplayActionStartTrace = {
  type: 'replay_action_start';
  step: number;
  line?: number;
  command?: string;
  positionals?: unknown[];
};

type ReplayActionStopTrace = {
  type: 'replay_action_stop';
  step: number;
  line?: number;
  command?: string;
  ok?: boolean;
  durationMs?: number;
  errorCode?: string;
  resultTiming?: Record<string, unknown>;
};

export function replayTestStepLines(result: ReplaySuiteTestResult): string[] {
  if (result.status === 'skipped') return [];
  const stops = readReplayStepTraces(result);
  if (stops.length === 0) return [];

  return [
    result.attempts > 1 ? `steps (attempt ${result.attempts}):` : 'steps:',
    ...stops.map(({ stop, start }) => renderReplayStepTrace(stop, start)),
  ];
}

export function replayTestFailureStepLines(
  result: Extract<ReplaySuiteTestResult, { status: 'failed' }>,
): string[] {
  const stops = readReplayStepTraces(result);
  const failedIndex = stops.findIndex(({ stop }) => stop.ok === false);
  if (failedIndex < 0) return [];
  const window = stops.slice(Math.max(0, failedIndex - 2), failedIndex + 1);
  return [
    result.attempts > 1 ? `steps (attempt ${result.attempts}):` : 'steps:',
    ...window.map(({ stop, start }) => renderReplayStepTrace(stop, start)),
  ];
}

function readReplayStepTraces(
  result: Extract<ReplaySuiteTestResult, { status: 'passed' | 'failed' }>,
): Array<{ stop: ReplayActionStopTrace; start: ReplayActionStartTrace | undefined }> {
  const tracePath = replayTestTimingTracePath(result);
  if (!tracePath) return [];
  const events = readReplayTimingTrace(tracePath);
  if (events.length === 0) return [];

  const starts: ReplayActionStartTrace[] = [];
  const stops: Array<{ stop: ReplayActionStopTrace; start: ReplayActionStartTrace | undefined }> =
    [];
  for (const event of events) {
    if (isReplayActionStartTrace(event)) {
      starts.push(event);
      continue;
    }
    if (isReplayActionStopTrace(event)) {
      stops.push({ stop: event, start: consumeReplayActionStart(starts, event) });
    }
  }
  return stops;
}

function consumeReplayActionStart(
  starts: ReplayActionStartTrace[],
  stop: ReplayActionStopTrace,
): ReplayActionStartTrace | undefined {
  const stopCommand = stop.command;
  const matchingIndex = starts.findIndex(
    (start) =>
      start.step === stop.step &&
      (stopCommand === undefined || start.command === undefined || start.command === stopCommand),
  );
  if (matchingIndex < 0) return undefined;
  return starts.splice(matchingIndex, 1)[0];
}

function replayTestTimingTracePath(
  result: Extract<ReplaySuiteTestResult, { status: 'passed' | 'failed' }>,
): string | undefined {
  return result.artifactsDir
    ? path.join(result.artifactsDir, `attempt-${result.attempts}`, 'replay-timing.ndjson')
    : undefined;
}

function readReplayTimingTrace(tracePath: string): Record<string, unknown>[] {
  try {
    return fs
      .readFileSync(tracePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isPlainRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function isReplayActionStartTrace(event: Record<string, unknown>): event is ReplayActionStartTrace {
  return (
    event.type === 'replay_action_start' &&
    hasTraceStep(event) &&
    hasOptionalNumber(event, 'line') &&
    hasOptionalString(event, 'command') &&
    (event.positionals === undefined || Array.isArray(event.positionals))
  );
}

function isReplayActionStopTrace(event: Record<string, unknown>): event is ReplayActionStopTrace {
  return allChecksPass([
    event.type === 'replay_action_stop' &&
      hasTraceStep(event) &&
      hasOptionalNumber(event, 'line') &&
      hasOptionalString(event, 'command'),
    hasOptionalBoolean(event, 'ok'),
    hasOptionalNumber(event, 'durationMs'),
    hasOptionalString(event, 'errorCode'),
    event.resultTiming === undefined || isPlainRecord(event.resultTiming),
  ]);
}

function hasTraceStep(event: Record<string, unknown>): boolean {
  return typeof event.step === 'number';
}

function hasOptionalNumber(event: Record<string, unknown>, key: string): boolean {
  return event[key] === undefined || typeof event[key] === 'number';
}

function hasOptionalString(event: Record<string, unknown>, key: string): boolean {
  return event[key] === undefined || typeof event[key] === 'string';
}

function hasOptionalBoolean(event: Record<string, unknown>, key: string): boolean {
  return event[key] === undefined || typeof event[key] === 'boolean';
}

function allChecksPass(checks: boolean[]): boolean {
  return checks.every(Boolean);
}

function renderReplayStepTrace(
  stop: ReplayActionStopTrace,
  start: ReplayActionStartTrace | undefined,
): string {
  const failed = stop.ok === false;
  const status = failed ? '[FAIL] ' : stop.ok === true ? '' : '[info] ';
  return `  ${status}${formatReplayStepCommand(start, stop)}${formatReplayStepDetails(stop, start)}`;
}

function formatReplayStepDetails(
  stop: ReplayActionStopTrace,
  start: ReplayActionStartTrace | undefined,
): string {
  const line = start?.line ?? stop.line;
  const details = [
    typeof line === 'number' ? `line ${line}` : '',
    typeof stop.durationMs === 'number' ? formatDurationSeconds(stop.durationMs) : '',
    stop.errorCode ?? '',
    stop.resultTiming ? `timing ${JSON.stringify(stop.resultTiming)}` : '',
  ].filter(Boolean);
  return details.length > 0 ? ` (${details.join(', ')})` : '';
}

function formatReplayStepCommand(
  start: ReplayActionStartTrace | undefined,
  stop: ReplayActionStopTrace,
): string {
  const command = formatReplayStepCommandName(start?.command ?? stop.command);
  const positionals = start?.positionals ?? [];
  return [command, ...positionals.map(formatReplayStepArg)].join(' ');
}

function formatReplayStepCommandName(command: string | undefined): string {
  if (!command) return 'unknown';
  if (!command.startsWith('__maestro')) return command;
  const name = command.slice('__maestro'.length);
  return name.length > 0 ? name[0]!.toLowerCase() + name.slice(1) : command;
}

function formatReplayStepArg(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
