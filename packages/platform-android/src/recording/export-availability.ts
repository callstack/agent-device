import { AppError } from '@agent-device/kernel/errors';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  screenRecordingVideoArtifactPaths,
  type ScreenRecordingCompletion,
  type ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';

type Availability =
  | Readonly<{ status: 'present' }>
  | Readonly<{ status: 'missing' | 'unavailable'; path: string }>;

export async function androidExportAvailability(
  host: PlatformRuntimeHost,
  completion: ScreenRecordingCompletion,
): Promise<Availability> {
  for (const artifactPath of screenRecordingVideoArtifactPaths(completion)) {
    const status = await host.screenRecording.outputs
      .inspect(artifactPath)
      .catch(() => 'unavailable' as const);
    if (status !== 'present') return { status, path: artifactPath };
  }
  return { status: 'present' };
}

export function guardAndroidRecordingExport(
  host: PlatformRuntimeHost,
  handle: ScreenRecordingLiveHandle,
): ScreenRecordingLiveHandle {
  return Object.freeze({
    ...handle,
    finish: async (progress?: DurableCaptureProgress) => {
      const outcome = await handle.finish(progress);
      if (outcome.status === 'completed') {
        const availability = await androidExportAvailability(host, outcome.result);
        if (availability.status !== 'present')
          throw new AppError('COMMAND_FAILED', 'Android recording export is unavailable', {
            reason: availability.status === 'missing' ? 'resource-missing' : 'owner-unavailable',
            outPath: availability.path,
          });
      }
      return outcome;
    },
  });
}
