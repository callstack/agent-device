import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import type { NativePathDisposition } from '@agent-device/contracts/recording-native-path';
import type { StopObservation } from '@agent-device/contracts/recording-stop-observation';
import type { ScreenRecordingFinalizer } from '@agent-device/contracts/screen-recording-runtime-host';

/**
 * Builds the one object `record stop` answers with. Every backend states both facts a stop can
 * prove about itself — what became of its recorder, and what became of the path that recorder wrote
 * to (ADR 0024 2.2 and 2.3) — beside the media it finalized.
 */
export function createScreenRecordingCompletion(
  snapshot: ScreenRecordingLiveSnapshot,
  finalization: Awaited<ReturnType<ScreenRecordingFinalizer['complete']>> &
    Readonly<{
      /** Set when one recorder produced several files that the export is served as. */
      chunks?: readonly ScreenRecordingChunk[];
      capturedDurationMs?: number;
    }>,
  facts: Readonly<{
    stopObservation: StopObservation;
    nativePathDisposition?: NativePathDisposition;
    showTouches?: boolean;
  }>,
): Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }> {
  const { stopObservation, nativePathDisposition, showTouches = snapshot.showTouches } = facts;
  return Object.freeze({
    status: 'completed',
    result: Object.freeze({
      backend: snapshot.backend,
      outPath: snapshot.outPath,
      ...(snapshot.clientOutPath === undefined ? {} : { clientOutPath: snapshot.clientOutPath }),
      startedAt: snapshot.startedAt,
      completedAt: Date.now(),
      stopObservation,
      ...(nativePathDisposition === undefined ? {} : { nativePathDisposition }),
      scope: snapshot.scope,
      showTouches,
      recordOnlySession: snapshot.recordOnlySession,
      ...(snapshot.activeSessionApp === undefined
        ? {}
        : { activeSessionApp: snapshot.activeSessionApp }),
      ...finalization,
    }),
  });
}
