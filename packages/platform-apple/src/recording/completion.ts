import { asAppError } from '@agent-device/kernel/errors';
import type { NativePathDisposition } from '@agent-device/contracts/recording-native-path';
import type { StopObservation } from '@agent-device/contracts/recording-stop-observation';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import { createScreenRecordingCompletion } from '@agent-device/capture-kit';
import type { AppleScreenRecordingOperationHost } from './recovery.ts';

/** Finalizes what the recorder wrote and states what this stop proved about the recorder and its file. */
export async function completeAppleRecording(params: {
  host: AppleScreenRecordingOperationHost;
  snapshot: ScreenRecordingLiveSnapshot;
  targetLabel: string;
  stopObservation: StopObservation;
  recorderWarning?: string;
  nativePathDisposition?: NativePathDisposition;
}): Promise<Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }>> {
  const { host, snapshot, targetLabel, recorderWarning, nativePathDisposition } = params;
  // An invalidated recording lost the session that held its recorder, so whatever signalled the
  // writer proved nothing about this stop (ADR 0024 2.2).
  const stopObservation: StopObservation = snapshot.invalidatedReason
    ? { recorder: 'lost', why: 'owner-session-lost' }
    : params.stopObservation;
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
  return createScreenRecordingCompletion(
    snapshot,
    {
      ...finalization,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
      ...(snapshot.invalidatedReason
        ? { overlayWarning: `overlay unavailable: ${snapshot.invalidatedReason}` }
        : {}),
    },
    {
      stopObservation,
      ...(nativePathDisposition === undefined ? {} : { nativePathDisposition }),
    },
  );
}
