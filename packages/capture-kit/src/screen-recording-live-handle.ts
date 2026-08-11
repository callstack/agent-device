import { AppError } from '@agent-device/kernel/errors';
import {
  isConfirmedCleanup,
  type CleanupOutcome,
  type FinishOutcome,
  type RecordingGestureEvent,
  type ScreenRecordingCompletion,
  type ScreenRecordingLiveHandle,
  type ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/platform';
import type { GestureReferenceFrame } from '@agent-device/contracts/interaction';

type ScreenRecordingLiveHandleImplementation = Readonly<{
  finish(snapshot: ScreenRecordingLiveSnapshot): Promise<FinishOutcome<ScreenRecordingCompletion>>;
  forceCleanup(snapshot: ScreenRecordingLiveSnapshot): Promise<CleanupOutcome>;
}>;

/** Owns mutable recording telemetry without leaking it into daemon session state. */
export function createScreenRecordingLiveHandle(
  initial: ScreenRecordingLiveSnapshot,
  implementation: ScreenRecordingLiveHandleImplementation,
): ScreenRecordingLiveHandle {
  let snapshot = freezeSnapshot(initial);
  let finish: Promise<FinishOutcome<ScreenRecordingCompletion>> | undefined;
  let cleanup: Promise<CleanupOutcome> | undefined;
  let disposal: Promise<void> | undefined;
  const finishRecording = () => (finish ??= implementation.finish(snapshot));
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
      if (events.length === 0 || finish || cleanup) return;
      snapshot = freezeSnapshot({
        ...snapshot,
        gestureEvents: [...snapshot.gestureEvents, ...events],
      });
    },
    setTouchReferenceFrame: (touchReferenceFrame: GestureReferenceFrame | undefined) => {
      if (finish || cleanup) return;
      snapshot = freezeSnapshot({
        ...snapshot,
        ...(touchReferenceFrame ? { touchReferenceFrame } : {}),
      });
    },
    setRunnerSessionId: (runnerSessionId: string) => {
      if (finish || cleanup || runnerSessionId.trim().length === 0) return;
      snapshot = freezeSnapshot({ ...snapshot, runnerSessionId });
    },
    invalidate: (invalidatedReason: string) => {
      if (finish || cleanup || snapshot.invalidatedReason) return;
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
