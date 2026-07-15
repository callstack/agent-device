import { formatMaestroCommandProgress } from '../../compat/maestro/progress.ts';
import type {
  MaestroEngineEvent,
  MaestroEngineObserver,
  MaestroRuntimeMetrics,
} from '../../compat/maestro/engine-types.ts';
import { AppError } from '../../kernel/errors.ts';
import { emitRequestProgress, readReplayTestActionProgress } from '../../request/progress.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import type { MaestroFailedEngineEvent } from './session-replay-maestro-failure.ts';
import { appendReplayTraceEvent } from './session-replay-trace.ts';

export function createMaestroReplayObserver(params: {
  filePath: string;
  tracePath: string | undefined;
  onFailure: (event: MaestroFailedEngineEvent) => void;
}): MaestroEngineObserver {
  const { filePath, tracePath, onFailure } = params;
  const traceStarts = new Map<number, MaestroEngineEvent>();
  return {
    commandStarted: (event) => {
      traceStarts.set(event.stepIndex, event);
      runTelemetrySink(() => emitMaestroProgress(filePath, event));
      runTelemetrySink(() => appendMaestroTraceStart(tracePath, filePath, event));
    },
    commandCompleted: (event) => {
      const traceEvent = takeTraceStart(traceStarts, event.stepIndex);
      runTelemetrySink(() =>
        appendMaestroTraceStop(tracePath, filePath, traceStopEvent(traceEvent, event), true),
      );
    },
    commandFailed: (event) => {
      const traceEvent = takeTraceStart(traceStarts, event.stepIndex);
      runTelemetrySink(() => onFailure(event));
      runTelemetrySink(() =>
        appendMaestroTraceStop(tracePath, filePath, traceStopEvent(traceEvent, event), false),
      );
    },
  };
}

function runTelemetrySink(callback: () => void): void {
  try {
    callback();
  } catch {}
}

function takeTraceStart(
  traceStarts: Map<number, MaestroEngineEvent>,
  stepIndex: number,
): MaestroEngineEvent | undefined {
  const event = traceStarts.get(stepIndex);
  traceStarts.delete(stepIndex);
  return event;
}

function traceStopEvent(
  start: MaestroEngineEvent | undefined,
  event: MaestroEngineEvent & {
    durationMs: number;
    runtimeMetrics?: MaestroRuntimeMetrics;
    error?: unknown;
  },
): MaestroEngineEvent & {
  durationMs: number;
  runtimeMetrics?: MaestroRuntimeMetrics;
  error?: unknown;
} {
  return stripUndefined({
    ...(start ?? event),
    durationMs: event.durationMs,
    runtimeMetrics: event.runtimeMetrics,
    error: event.error,
  });
}

function emitMaestroProgress(file: string, event: MaestroEngineEvent): void {
  const progress = readReplayTestActionProgress();
  if (!progress) return;
  const formatted = formatMaestroCommandProgress(event.command);
  emitRequestProgress({
    type: 'replay-test',
    ...progress,
    file: progress.file || file,
    status: 'progress',
    stepIndex: event.stepIndex,
    stepTotal: event.stepTotal,
    stepCommand: formatted.command,
    ...(formatted.value ? { stepValue: formatted.value } : {}),
  });
}

function appendMaestroTraceStart(
  tracePath: string | undefined,
  replayPath: string,
  event: MaestroEngineEvent,
): void {
  const formatted = formatMaestroCommandProgress(event.command);
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_start',
    ts: new Date().toISOString(),
    replayPath,
    ...(event.source.path && event.source.path !== replayPath
      ? { sourcePath: event.source.path }
      : {}),
    line: event.source.line,
    step: event.stepIndex,
    command: formatted.command,
    positionals: formatted.value ? [formatted.value] : [],
  });
}

function appendMaestroTraceStop(
  tracePath: string | undefined,
  replayPath: string,
  event: MaestroEngineEvent & {
    durationMs: number;
    runtimeMetrics?: MaestroRuntimeMetrics;
    error?: unknown;
  },
  ok: boolean,
): void {
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_stop',
    ts: new Date().toISOString(),
    replayPath,
    ...(event.source.path && event.source.path !== replayPath
      ? { sourcePath: event.source.path }
      : {}),
    line: event.source.line,
    step: event.stepIndex,
    command: formatMaestroCommandProgress(event.command).command,
    ok,
    durationMs: event.durationMs,
    ...(event.runtimeMetrics ? { resultTiming: event.runtimeMetrics } : {}),
    ...(!ok && event.error instanceof AppError ? { errorCode: event.error.code } : {}),
  });
}
