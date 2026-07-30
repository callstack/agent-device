import type {
  MaestroActionEvent,
  MaestroCompletedActionEvent,
  MaestroExecutionObserver,
  MaestroFailedAction,
} from '@agent-device/maestro';
import { AppError } from '@agent-device/kernel/errors';
import type { ReplayTestAttemptStepSink } from './session-test-types.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import { appendReplayTraceEvent } from './session-replay-trace.ts';

export function createMaestroReplayObserver(params: {
  filePath: string;
  tracePath: string | undefined;
  onStep?: ReplayTestAttemptStepSink;
}): MaestroExecutionObserver {
  const { filePath, tracePath, onStep } = params;
  const traceStarts = new Map<number, MaestroActionEvent>();
  return {
    actionStarted: (event) => {
      traceStarts.set(event.stepIndex, event);
      runTelemetrySink(() => emitMaestroStep(onStep, event));
      runTelemetrySink(() => appendMaestroTraceStart(tracePath, filePath, event));
    },
    actionCompleted: (event) => {
      const traceEvent = takeTraceStart(traceStarts, event.stepIndex);
      runTelemetrySink(() =>
        appendMaestroTraceStop(tracePath, filePath, traceStopEvent(traceEvent, event), true),
      );
    },
    actionFailed: (event) => {
      const traceEvent = takeTraceStart(traceStarts, event.stepIndex);
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
  traceStarts: Map<number, MaestroActionEvent>,
  stepIndex: number,
): MaestroActionEvent | undefined {
  const event = traceStarts.get(stepIndex);
  traceStarts.delete(stepIndex);
  return event;
}

function traceStopEvent(
  start: MaestroActionEvent | undefined,
  event: MaestroCompletedActionEvent | MaestroFailedAction,
): MaestroCompletedActionEvent | MaestroFailedAction {
  return stripUndefined({
    ...(start ?? event),
    durationMs: event.durationMs,
    runtimeMetrics: event.runtimeMetrics,
    data: 'data' in event ? event.data : undefined,
    error: 'error' in event ? event.error : undefined,
  });
}

function emitMaestroStep(
  onStep: ReplayTestAttemptStepSink | undefined,
  event: MaestroActionEvent,
): void {
  onStep?.({
    index: event.stepIndex,
    total: event.stepTotal,
    command: event.action,
    ...(event.value ? { value: event.value } : {}),
  });
}

function appendMaestroTraceStart(
  tracePath: string | undefined,
  replayPath: string,
  event: MaestroActionEvent,
): void {
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_start',
    ts: new Date().toISOString(),
    replayPath,
    ...(event.source.path && event.source.path !== replayPath
      ? { sourcePath: event.source.path }
      : {}),
    line: event.source.line,
    step: event.stepIndex,
    command: event.action,
    positionals: event.value ? [event.value] : [],
  });
}

function appendMaestroTraceStop(
  tracePath: string | undefined,
  replayPath: string,
  event: MaestroCompletedActionEvent | MaestroFailedAction,
  ok: boolean,
): void {
  const resultTiming = maestroResultTiming(event);
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_stop',
    ts: new Date().toISOString(),
    replayPath,
    ...(event.source.path && event.source.path !== replayPath
      ? { sourcePath: event.source.path }
      : {}),
    line: event.source.line,
    step: event.stepIndex,
    command: event.action,
    ok,
    durationMs: event.durationMs,
    ...(Object.keys(resultTiming).length > 0 ? { resultTiming } : {}),
    ...(!ok && 'error' in event && event.error instanceof AppError
      ? { errorCode: event.error.code }
      : {}),
  });
}

function maestroResultTiming(
  event: MaestroCompletedActionEvent | MaestroFailedAction,
): Record<string, unknown> {
  const data = 'data' in event ? event.data : undefined;
  const timing = isPlainRecord(data?.timing) ? data.timing : undefined;
  return stripUndefined({
    ...(event.runtimeMetrics ?? {}),
    ...(typeof timing?.executionProfile === 'string'
      ? { executionProfile: timing.executionProfile }
      : {}),
    ...(typeof timing?.gestureDurationMs === 'number'
      ? { gestureDurationMs: timing.gestureDurationMs }
      : {}),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
