import { asAppError } from '@agent-device/kernel/errors';
import type { ScreenRecordingLiveSnapshot } from '@agent-device/contracts/screen-recording-runtime';
import { createScreenRecordingCompletion } from '@agent-device/capture-kit';
import type { AppleScreenRecordingOperationHost } from './recovery.ts';

export async function completeAppleRecording(
  host: AppleScreenRecordingOperationHost,
  snapshot: ScreenRecordingLiveSnapshot,
  targetLabel: string,
) {
  if (snapshot.invalidatedReason && !snapshot.showTouches) {
    throw new Error(`recording invalidated: ${snapshot.invalidatedReason}`);
  }
  let finalization;
  try {
    finalization = await host.screenRecording.finalize.complete({
      outputPath: snapshot.outPath,
      showTouches: snapshot.invalidatedReason ? false : snapshot.showTouches,
      gestureEvents: snapshot.gestureEvents,
      exportQuality: snapshot.exportQuality ?? 'medium',
      ...(snapshot.runnerStartedAtUptimeMs !== undefined &&
      snapshot.targetAppReadyUptimeMs !== undefined
        ? {
            trimStartMs: Math.max(
              0,
              snapshot.targetAppReadyUptimeMs - snapshot.runnerStartedAtUptimeMs,
            ),
          }
        : {}),
      targetLabel,
    });
  } catch (error) {
    throw asAppError(error, 'COMMAND_FAILED');
  }
  return createScreenRecordingCompletion(snapshot, {
    ...finalization,
    ...(snapshot.invalidatedReason
      ? { overlayWarning: `overlay unavailable: ${snapshot.invalidatedReason}` }
      : {}),
  });
}
