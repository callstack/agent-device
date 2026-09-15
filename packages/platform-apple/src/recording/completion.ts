import { asAppError } from '@agent-device/kernel/errors';
import type { ScreenRecordingFinalization } from '@agent-device/contracts/recording-stop-progress';
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

/**
 * Turns the copy a stop collected into the export, and answers what became of the recorder's own
 * file (ADR 0024 2.3). The recorder's file is never finalized in place: the overlay and the telemetry
 * land on the export, and the recorder's file is retired only once that export exists.
 */
export async function finalizeAppleRecordingFromCollected(
  params: Readonly<{
    host: AppleScreenRecordingOperationHost;
    snapshot: ScreenRecordingLiveSnapshot;
    targetLabel: string;
    collectedPath: string;
    exportPath: string;
    nativePath: string;
  }>,
): Promise<ScreenRecordingFinalization> {
  const { host, snapshot, targetLabel, collectedPath, exportPath, nativePath } = params;
  // A recording whose session died cannot honour a touch overlay it no longer has events for, and
  // promising the overlay and serving none is worse than refusing while the file is still there.
  if (snapshot.invalidatedReason && !snapshot.showTouches) {
    throw new Error(`recording invalidated: ${snapshot.invalidatedReason}`);
  }
  let finalization: Awaited<ReturnType<typeof host.screenRecording.finalize.complete>>;
  try {
    await host.screenRecording.outputs.copy({ from: collectedPath, to: exportPath });
    finalization = await asAppErrorAsync(() =>
      host.screenRecording.finalize.complete({
        outputPath: exportPath,
        showTouches: snapshot.invalidatedReason ? false : snapshot.showTouches,
        gestureEvents: snapshot.gestureEvents,
        exportQuality: snapshot.exportQuality ?? 'medium',
        targetLabel,
      }),
    );
  } catch (error) {
    // `--out` only ever holds bytes the finalizer accepted. The collected copy stays for the retry.
    await host.screenRecording.outputs.remove(exportPath);
    throw error;
  }
  return {
    ...finalization,
    ...(snapshot.invalidatedReason
      ? { overlayWarning: `overlay unavailable: ${snapshot.invalidatedReason}` }
      : {}),
    nativePathDisposition:
      (await host.screenRecording.outputs.remove(nativePath)) === 'removed'
        ? 'retired'
        : 'retirable',
  };
}

async function asAppErrorAsync<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asAppError(error, 'COMMAND_FAILED');
  }
}
