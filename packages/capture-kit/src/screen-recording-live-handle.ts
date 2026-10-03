import { AppError } from '@agent-device/kernel/errors';
import {
  type CleanupOutcome,
  type DurableCaptureProgress,
  type FinishOutcome,
  isConfirmedCleanup,
} from '@agent-device/contracts/durable-resource';
import type {
  RecordingGestureEvent,
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import type { GestureReferenceFrame } from '@agent-device/contracts/scroll-gesture';

/**
 * What a backend owes a recording. `finish` receives the manifest the stop may write checkpoints
 * into (ADR 0024 2.3): a backend that sequences its stop through the shared steps gets the
 * checkpoints, the re-signal rule, and the refusal to finalize a recorder's own path in place for
 * free, and one that owns its finish keeps its own order until it migrates.
 */
export type ScreenRecordingLiveHandleImplementation = Readonly<{
  finish(
    snapshot: ScreenRecordingLiveSnapshot,
    progress?: DurableCaptureProgress,
  ): Promise<FinishOutcome<ScreenRecordingCompletion>>;
  forceCleanup(snapshot: ScreenRecordingLiveSnapshot): Promise<CleanupOutcome>;
}>;

/** Owns mutable recording telemetry without leaking it into daemon session state. */
export function createScreenRecordingLiveHandle(
  initial: ScreenRecordingLiveSnapshot,
  implementation: ScreenRecordingLiveHandleImplementation,
): ScreenRecordingLiveHandle {
  let snapshot = freezeSnapshot(initial);
  let finish: Promise<FinishOutcome<ScreenRecordingCompletion>> | undefined;
  let finishRequested = false;
  let cleanup: Promise<CleanupOutcome> | undefined;
  let disposal: Promise<void> | undefined;
  // Once a finish or a cleanup has been asked for, the recording no longer accepts telemetry.
  const terminal = (): boolean => finishRequested || cleanup !== undefined;
  const finishRecording = (progress?: DurableCaptureProgress) => {
    // Only a finished recording stays memoized. A finish the host refused has to be re-driven
    // by the next `record stop`, which is how a recording recovers without a daemon restart.
    finishRequested = true;
    finish ??= implementation.finish(snapshot, progress).catch((error: unknown) => {
      finish = undefined;
      throw error;
    });
    return finish;
  };
  const forceCleanup = () =>
    (cleanup ??= finish
      ? finish.then(
          async (outcome) =>
            outcome.status === 'completed'
              ? ({ status: 'cleaned' } as const)
              : await implementation.forceCleanup(snapshot),
          async () => await implementation.forceCleanup(snapshot),
        )
      : implementation.forceCleanup(snapshot));
  return Object.freeze({
    inspect: () => snapshot,
    appendGestureEvents: (events: readonly RecordingGestureEvent[]) => {
      if (events.length === 0 || terminal()) return;
      snapshot = freezeSnapshot({
        ...snapshot,
        gestureEvents: [...snapshot.gestureEvents, ...events],
      });
    },
    setTouchReferenceFrame: (touchReferenceFrame: GestureReferenceFrame | undefined) => {
      if (terminal()) return;
      snapshot = freezeSnapshot({
        ...snapshot,
        ...(touchReferenceFrame ? { touchReferenceFrame } : {}),
      });
    },
    setRunnerSessionId: (runnerSessionId: string) => {
      if (terminal() || runnerSessionId.trim().length === 0) return;
      snapshot = freezeSnapshot({ ...snapshot, runnerSessionId });
    },
    invalidate: (invalidatedReason: string) => {
      if (terminal() || snapshot.invalidatedReason) return;
      snapshot = freezeSnapshot({ ...snapshot, invalidatedReason });
    },
    finish: finishRecording,
    forceCleanup,
    [Symbol.asyncDispose]: async () => {
      disposal ??= forceCleanup().then(assertConfirmedCleanup);
      await disposal;
    },
  });
}

function freezeSnapshot(snapshot: ScreenRecordingLiveSnapshot): ScreenRecordingLiveSnapshot {
  return Object.freeze({ ...snapshot, gestureEvents: Object.freeze([...snapshot.gestureEvents]) });
}

function assertConfirmedCleanup(outcome: CleanupOutcome): void {
  if (isConfirmedCleanup(outcome)) return;
  throw new AppError(
    'COMMAND_FAILED',
    outcome.message ?? 'Screen recording cleanup could not be confirmed',
    {
      reason: outcome.reason,
      retriable: outcome.reason !== 'ownership-fence-lost',
      hint:
        outcome.reason === 'ownership-fence-lost'
          ? 'Use the current recording owner or recovery record before retrying cleanup.'
          : 'Keep the recovery record and retry cleanup through the exact runtime owner.',
    },
  );
}
