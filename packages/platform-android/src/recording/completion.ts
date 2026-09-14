import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import { measureCapturedWindow } from './captured-window.ts';

const PLATFORM_LIMIT_WARNING =
  'Android adb screenrecord stopped before record stop, likely after reaching the 180s platform ' +
  'limit. The MP4 may be truncated; final interactions after the limit are not in the video.';
const CHUNKED_WARNING =
  'Android adb screenrecord is capped at 180s, so this recording was split into multiple MP4 chunks.';
const CHUNKED_OVERLAY_WARNING =
  'touch overlay burn-in is skipped for chunked Android recordings; returning raw chunks plus ' +
  'gesture telemetry';

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

export async function completed(params: {
  host: PlatformRuntimeHost;
  recording: ScreenRecordingLiveSnapshot;
  chunks: readonly ScreenRecordingChunk[];
  targetLabel: string;
  reachedLimit: boolean;
  startedAtMs: number;
  stoppedAtMs: number;
}): Promise<Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }>> {
  const { host, recording, chunks, targetLabel, reachedLimit, startedAtMs, stoppedAtMs } = params;
  const chunked = chunks.length > 1;
  const finalization = await host.screenRecording.finalize.complete({
    outputPath: recording.outPath,
    showTouches: chunked ? false : recording.showTouches,
    gestureEvents: recording.gestureEvents,
    exportQuality: recording.exportQuality ?? 'medium',
    targetLabel,
  });
  const captured = measureCapturedWindow({
    chunkPaths: chunks.map((chunk) => chunk.path),
    startedAtMs,
    stoppedAtMs,
  });
  const warnings = [
    ...(finalization.warning ? [finalization.warning] : []),
    ...(reachedLimit ? [PLATFORM_LIMIT_WARNING] : []),
    ...(chunked ? [CHUNKED_WARNING] : []),
    ...(captured.idleTailWarning ? [captured.idleTailWarning] : []),
  ];
  const completedAt = Date.now();
  return {
    status: 'completed',
    result: {
      backend: recording.backend,
      outPath: recording.outPath,
      ...(recording.clientOutPath ? { clientOutPath: recording.clientOutPath } : {}),
      startedAt: recording.startedAt,
      completedAt,
      scope: recording.scope,
      showTouches: recording.showTouches,
      recordOnlySession: recording.recordOnlySession,
      ...(recording.activeSessionApp ? { activeSessionApp: recording.activeSessionApp } : {}),
      ...(chunked ? { chunks } : {}),
      ...finalization,
      ...(captured.capturedDurationMs === undefined
        ? {}
        : { capturedDurationMs: captured.capturedDurationMs }),
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      ...(chunked && recording.showTouches && recording.gestureEvents.length > 0
        ? { overlayWarning: CHUNKED_OVERLAY_WARNING }
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
