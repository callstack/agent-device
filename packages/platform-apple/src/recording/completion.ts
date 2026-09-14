import { asAppError } from '@agent-device/kernel/errors';
import type { ScreenRecordingLiveSnapshot } from '@agent-device/contracts/screen-recording-runtime';
import { createScreenRecordingCompletion } from '@agent-device/capture-kit';
import type { AppleScreenRecordingOperationHost } from './recovery.ts';

export async function completeAppleRecording(
  host: AppleScreenRecordingOperationHost,
  snapshot: ScreenRecordingLiveSnapshot,
  targetLabel: string,
  recorderWarning?: string,
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
      targetLabel,
    });
  } catch (error) {
    throw asAppError(error, 'COMMAND_FAILED');
  }
  const warnings = [
    ...(finalization.warning ? [finalization.warning] : []),
    ...(recorderWarning ? [recorderWarning] : []),
  ];
  return createScreenRecordingCompletion(snapshot, {
    ...finalization,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    ...(snapshot.invalidatedReason
      ? { overlayWarning: `overlay unavailable: ${snapshot.invalidatedReason}` }
      : {}),
  });
}
