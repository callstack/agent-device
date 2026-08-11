import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createHarmonyScreenRecordingHost(): ScreenRecordingRuntimeHost['harmony'] {
  return Object.freeze({
    start: async (device, fileName, signal) =>
      await hdc(
        device,
        [
          'shell',
          'aa',
          'start',
          '-b',
          'com.huawei.hmos.screenrecorder',
          '-a',
          'com.huawei.hmos.screenrecorder.ServiceExtAbility',
          '--ps',
          'CustomizedFileName',
          fileName,
        ],
        signal,
      ),
    stop: async (device, signal) =>
      await hdc(
        device,
        [
          'shell',
          'aa',
          'start',
          '-b',
          'com.huawei.hmos.screenrecorder',
          '-a',
          'com.huawei.hmos.screenrecorder.ServiceExtAbility',
        ],
        signal,
      ),
    findMedia: async (device, fileName, signal) =>
      (await hdc(device, ['shell', 'mediatool', 'query', fileName, '-u'], signal)).stdout.match(
        /file:\/\/[^\s"']+/,
      )?.[0],
    stageMedia: async (device, input, signal) =>
      (await hdc(device, ['shell', 'mediatool', 'recv', input.mediaUri, input.remotePath], signal))
        .exitCode === 0,
    stagedFileSize: async (device, remotePath, signal) => {
      const result = await hdc(device, ['shell', 'stat', '-c', '%s', remotePath], signal);
      if (result.exitCode !== 0) return undefined;
      const size = Number(result.stdout.trim());
      return Number.isSafeInteger(size) && size > 0 ? size : undefined;
    },
    pull: async (device, input, signal) =>
      await hdc(device, ['file', 'recv', input.remotePath, input.outputPath], signal),
    remove: async (device, remotePath, signal) =>
      (await hdc(device, ['shell', 'rm', '-f', remotePath], signal)).exitCode === 0,
    removeMedia: async (device, mediaUri, signal) =>
      (await hdc(device, ['shell', 'mediatool', 'delete', mediaUri], signal)).exitCode === 0,
  });
}

async function hdc(device: DeviceInfo, args: string[], signal?: AbortSignal) {
  const { runHarmonyHdc } = await import('./platforms/harmonyos/hdc.ts');
  return await runHarmonyHdc(device, args, { allowFailure: true, signal });
}
