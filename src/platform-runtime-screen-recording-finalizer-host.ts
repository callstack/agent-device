import { AppError } from '@agent-device/kernel/errors';
import { RECORDING_OUTPUT_UNPLAYABLE_REASON } from '@agent-device/contracts/screen-recording-runtime';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import {
  getRecordingOverlaySupportWarning,
  overlayRecordingTouches,
} from '@agent-device/capture-kit/recording-overlay';
import { persistRecordingTelemetry } from '@agent-device/capture-kit/recording-telemetry';
import {
  isPlayableVideo,
  waitForPlayableVideo,
  waitForStableFile,
} from '@agent-device/capture-kit/recording-video';

export function createScreenRecordingFinalizer(): ScreenRecordingRuntimeHost['finalize'] {
  return Object.freeze({ complete: finalizeScreenRecording });
}

async function finalizeScreenRecording(
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
) {
  await waitForStableFile(input.outputPath);
  await waitForPlayableVideo(input.outputPath);
  if (!(await isPlayableVideo(input.outputPath))) {
    throw new AppError(
      'COMMAND_FAILED',
      `recording was not finalized into a playable video: ${input.outputPath}`,
      {
        reason: RECORDING_OUTPUT_UNPLAYABLE_REASON,
        retriable: true,
        hint:
          'Run record stop again: a recorder that is still finalizing its file is playable on the ' +
          'next stop, and the recording keeps its evidence either way. If the recorder died before ' +
          'writing a video, close this session to release the device and record again.',
      },
    );
  }
  const telemetryPath = persistRecordingTelemetry({
    recording: { outPath: input.outputPath, gestureEvents: [...input.gestureEvents] },
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
