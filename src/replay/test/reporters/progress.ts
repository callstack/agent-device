import type { RequestProgressEvent } from '../../../request/progress.ts';
import type { ReplayTestReporterProgressEvent } from './types.ts';

export function toReplayTestReporterProgressEvent(
  event: RequestProgressEvent,
): ReplayTestReporterProgressEvent | undefined {
  if (event.type === 'command') return undefined;
  if (event.type === 'replay-test-suite') {
    return {
      type: 'suite-start',
      suite: {
        total: event.total,
        runnable: event.runnable,
        skipped: event.skipped,
        artifactsDir: event.artifactsDir,
        shardMode: event.shardMode,
        shardCount: event.shardCount,
      },
    };
  }
  const test = {
    file: event.file,
    title: event.title,
    index: event.index,
    total: event.total,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    session: event.session,
    artifactsDir: event.artifactsDir,
    shardIndex: event.shardIndex,
    shardCount: event.shardCount,
    deviceId: event.deviceId,
    deviceName: event.deviceName,
  };
  if (event.status === 'start') return { type: 'test-start', test };
  if (event.status === 'progress') {
    return {
      type: 'test-step',
      test: {
        ...test,
        stepIndex: event.stepIndex,
        stepTotal: event.stepTotal,
        stepCommand: event.stepCommand,
        stepValue: event.stepValue,
      },
    };
  }
  return {
    type: 'test-result',
    test: {
      ...test,
      status: event.status,
      durationMs: event.durationMs,
      retrying: event.retrying,
      message: event.message,
      hint: event.hint,
    },
  };
}
