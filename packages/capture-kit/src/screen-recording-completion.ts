import type {
  ScreenRecordingCompletion,
  ScreenRecordingFinalizer,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/platform';

export function createScreenRecordingCompletion(
  snapshot: ScreenRecordingLiveSnapshot,
  finalization: Awaited<ReturnType<ScreenRecordingFinalizer['complete']>>,
  showTouches = snapshot.showTouches,
): Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }> {
  return Object.freeze({
    status: 'completed',
    result: Object.freeze({
      backend: snapshot.backend,
      outPath: snapshot.outPath,
      ...(snapshot.clientOutPath === undefined ? {} : { clientOutPath: snapshot.clientOutPath }),
      startedAt: snapshot.startedAt,
      completedAt: Date.now(),
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
