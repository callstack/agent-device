import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ShellWord } from '@agent-device/kernel/device-shell';

export function createHarmonyScreenRecordingHost(): ScreenRecordingRuntimeHost['harmony'] {
  return Object.freeze({
    start: async (device, fileName, signal) =>
      await hdcShell(
        device,
        [
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
      await hdcShell(
        device,
        [
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
      (await hdcShell(device, ['mediatool', 'query', fileName, '-u'], signal)).stdout.match(
        /file:\/\/[^\s"']+/,
      )?.[0],
    stageMedia: async (device, input, signal) =>
      (await hdcShell(device, ['mediatool', 'recv', input.mediaUri, input.remotePath], signal))
        .exitCode === 0,
    stagedFileSize: async (device, remotePath, signal) => {
      const result = await hdcShell(device, ['stat', '-c', '%s', remotePath], signal);
      if (result.exitCode !== 0) return undefined;
      const size = Number(result.stdout.trim());
      return Number.isSafeInteger(size) && size > 0 ? size : undefined;
    },
    pull: async (device, input, signal) =>
      await hdc(device, ['file', 'recv', input.remotePath, input.outputPath], signal),
    remove: async (device, remotePath, signal) =>
      (await hdcShell(device, ['rm', '-f', remotePath], signal)).exitCode === 0,
    removeMedia: async (device, mediaUri, signal) =>
      (await hdcShell(device, ['mediatool', 'delete', mediaUri], signal)).exitCode === 0,
  });
}

async function hdc(device: DeviceInfo, args: string[], signal?: AbortSignal) {
  const { runHarmonyHdc } = await import('@agent-device/platform-harmonyos');
  return await runHarmonyHdc(device, args, { allowFailure: true, signal });
}

async function hdcShell(device: DeviceInfo, words: readonly ShellWord[], signal?: AbortSignal) {
  const { runHarmonyShell } = await import('@agent-device/platform-harmonyos');
  return await runHarmonyShell(device, words, { allowFailure: true, signal });
}
