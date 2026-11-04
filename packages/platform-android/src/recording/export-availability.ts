import { AppError } from '@agent-device/kernel/errors';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';

type Availability = 'present' | 'missing' | 'unavailable';

export async function androidExportAvailability(
  host: PlatformRuntimeHost,
  outputPath: string,
): Promise<Availability> {
  return await host.screenRecording.outputs.inspect(outputPath).catch(() => 'unavailable' as const);
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
        const availability = await androidExportAvailability(host, outcome.result.outPath);
        if (availability !== 'present')
          throw new AppError('COMMAND_FAILED', 'Android recording export is unavailable', {
            reason: availability === 'missing' ? 'resource-missing' : 'owner-unavailable',
            outPath: outcome.result.outPath,
          });
      }
      return outcome;
    },
  });
}
