import type {
  CleanupOutcome,
  PlatformRuntimeHost,
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';

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

export async function completed(
  host: PlatformRuntimeHost,
  recording: ScreenRecordingLiveSnapshot,
  chunks: readonly ScreenRecordingChunk[],
  targetLabel: string,
  reachedLimit = false,
): Promise<Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }>> {
  const chunked = chunks.length > 1;
  const finalization = await host.screenRecording.finalize.complete({
    outputPath: recording.outPath,
    showTouches: chunked ? false : recording.showTouches,
    gestureEvents: recording.gestureEvents,
    exportQuality: recording.exportQuality ?? 'medium',
    targetLabel,
  });
  const warnings = [
    ...(reachedLimit
      ? [
          'Android adb screenrecord stopped before record stop, likely after reaching the 180s platform limit. The MP4 may be truncated; final interactions after the limit are not in the video.',
        ]
      : []),
    ...(chunked
      ? [
          'Android adb screenrecord is capped at 180s, so this recording was split into multiple MP4 chunks.',
        ]
      : []),
  ];
  return {
    status: 'completed',
    result: {
      backend: recording.backend,
      outPath: recording.outPath,
      ...(recording.clientOutPath ? { clientOutPath: recording.clientOutPath } : {}),
      startedAt: recording.startedAt,
      completedAt: Date.now(),
      scope: recording.scope,
      showTouches: recording.showTouches,
      recordOnlySession: recording.recordOnlySession,
      ...(recording.activeSessionApp ? { activeSessionApp: recording.activeSessionApp } : {}),
      ...(chunked ? { chunks } : {}),
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      ...finalization,
      ...(chunked && recording.showTouches && recording.gestureEvents.length > 0
        ? {
            overlayWarning:
              'touch overlay burn-in is skipped for chunked Android recordings; returning raw chunks plus gesture telemetry',
          }
        : {}),
    },
  };
}

export function pending(error: unknown): CleanupOutcome {
  return {
    status: 'cleanup-pending',
    reason: 'transport-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}
