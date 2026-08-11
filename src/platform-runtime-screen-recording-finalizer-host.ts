import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/platform';
import {
  getRecordingOverlaySupportWarning,
  overlayRecordingTouches,
  trimRecordingStart,
} from './recording/overlay.ts';
import { persistRecordingTelemetry } from './daemon/recording-telemetry.ts';
import { isPlayableVideo, waitForPlayableVideo, waitForStableFile } from './utils/video.ts';

export function createScreenRecordingFinalizer(): ScreenRecordingRuntimeHost['finalize'] {
  return Object.freeze({ complete: finalizeScreenRecording });
}

async function finalizeScreenRecording(
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
) {
  await waitForStableFile(input.outputPath);
  await waitForPlayableVideo(input.outputPath);
  if (!(await isPlayableVideo(input.outputPath))) {
    throw new Error(`recording was not finalized into a playable video: ${input.outputPath}`);
  }
  if (input.trimStartMs && input.trimStartMs > 0) {
    await trimRecordingStart({ videoPath: input.outputPath, trimStartMs: input.trimStartMs });
  }
  const telemetryPath = persistRecordingTelemetry({
    recording: { outPath: input.outputPath, gestureEvents: [...input.gestureEvents] },
    ...(input.trimStartMs === undefined ? {} : { trimStartMs: input.trimStartMs }),
  });
  if (!input.showTouches || input.gestureEvents.length === 0) return { telemetryPath };
  return await overlayTouches(input, telemetryPath);
}

async function overlayTouches(
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
  telemetryPath: string,
) {
  const warning = getRecordingOverlaySupportWarning();
  if (warning) return { telemetryPath, overlayWarning: warning };
  try {
    await overlayRecordingTouches({
      videoPath: input.outputPath,
      telemetryPath,
      exportQuality: input.exportQuality,
      targetLabel: input.targetLabel,
    });
    if (!(await isPlayableVideo(input.outputPath))) {
      throw new Error('recording post-processing produced an unplayable video');
    }
    return { telemetryPath };
  } catch (error) {
    return {
      telemetryPath,
      overlayWarning: `failed to overlay recording touches: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
