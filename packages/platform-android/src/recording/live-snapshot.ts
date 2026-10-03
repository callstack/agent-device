import type {
  ScreenRecordingLiveSnapshot,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';

/** What an `adb screenrecord` session is while it runs, before any artifact exists. */
export function snapshot(
  input: ScreenRecordingStartInput,
  startedAt: number,
): ScreenRecordingLiveSnapshot {
  return Object.freeze({
    backend: 'adb screenrecord',
    outPath: input.outputPath,
    ...(input.clientOutputPath ? { clientOutPath: input.clientOutputPath } : {}),
    startedAt,
    scope: input.scope,
    showTouches: input.showTouches,
    recordOnlySession: input.recordOnlySession,
    ...(input.activeSessionApp ? { activeSessionApp: input.activeSessionApp } : {}),
    ...(input.exportQuality ? { exportQuality: input.exportQuality } : {}),
    gestureEvents: [],
  });
}
