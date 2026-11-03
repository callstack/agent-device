import { AppError } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { RECORDING_OUTPUT_UNPLAYABLE_REASON } from '@agent-device/contracts/screen-recording-runtime';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { Deadline } from '@agent-device/host-kit/retry';
import {
  getRecordingOverlaySupportWarning,
  overlayRecordingTouches,
  startRecordingOverlayBudget,
} from '@agent-device/capture-kit/recording-overlay';
import { persistRecordingTelemetry } from '@agent-device/capture-kit/recording-telemetry';
import {
  hasVideoContainer,
  prepareVideoValidator,
  readPreparedVideoValidator,
  type VideoValidator,
  isPlayableVideo,
  waitForPlayableVideo,
  waitForStableFile,
} from '@agent-device/capture-kit/recording-video';

export function createScreenRecordingFinalizer(
  host: HostEnvironment,
): ScreenRecordingRuntimeHost['finalize'] {
  return Object.freeze({
    prepare: async (input) => {
      if (input.container === 'mp4') void prepareVideoValidator(host);
    },
    sniff: async (input) => await sniffRecording(input),
    complete: async (input) => await finalizeScreenRecording(host, input),
  });
}

async function sniffRecording(input: Readonly<{ outputPath: string }>): Promise<void> {
  if (!(await hasVideoContainer(input.outputPath))) throw unplayableRecording(input.outputPath);
}

async function finalizeScreenRecording(
  host: HostEnvironment,
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
) {
  const validator = readPreparedVideoValidator(host);
  const finalizeDeadline = startRecordingOverlayBudget();
  await waitForStableFile(input.outputPath);
  if (!(await waitForPlayableVideo(input.outputPath, { validator, deadline: finalizeDeadline }))) {
    throw unplayableRecording(input.outputPath);
  }
  const telemetryPath = persistRecordingTelemetry({
    recording: { outPath: input.outputPath, gestureEvents: [...input.gestureEvents] },
  });
  if (!input.showTouches || input.gestureEvents.length === 0) return { telemetryPath };
  return await overlayTouches(host, input, telemetryPath, finalizeDeadline, validator);
}

async function overlayTouches(
  host: HostEnvironment,
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
  telemetryPath: string,
  deadline: Deadline,
  validator: VideoValidator | undefined,
) {
  const warning = getRecordingOverlaySupportWarning();
  if (warning) return { telemetryPath, overlayWarning: warning };
  try {
    await overlayRecordingTouches({
      host,
      videoPath: input.outputPath,
      telemetryPath,
      exportQuality: input.exportQuality,
      ...(input.fps === undefined ? {} : { fps: input.fps }),
      targetLabel: input.targetLabel,
      deadline,
      validator,
    });
    if (!(await isPlayableVideo(input.outputPath, validator, deadline))) {
      throw new Error(
        deadline.isExpired()
          ? 'recording post-processing verification exceeded the finalization budget'
          : 'recording post-processing produced an unplayable video',
      );
    }
    return { telemetryPath };
  } catch (error) {
    return {
      telemetryPath,
      overlayWarning: `failed to overlay recording touches: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function unplayableRecording(outputPath: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `recording was not finalized into a playable video: ${outputPath}`,
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
