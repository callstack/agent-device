import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';
import type { ShellWord } from '@agent-device/kernel/device-shell';
import { runHarmonyHdc, runHarmonyShell } from '../hdc.ts';

/**
 * The device-side HarmonyOS screen recorder, driven entirely through HDC. It is the family's own
 * transport: the shared screen-recording host keeps output preparation and video finalization, and
 * nothing else needs to know the recorder's ability ids or media-tool commands.
 */
export type HarmonyScreenRecorder = Readonly<{
  start(device: DeviceInfo, fileName: string, signal?: AbortSignal): Promise<HostCommandResult>;
  stop(device: DeviceInfo, signal?: AbortSignal): Promise<HostCommandResult>;
  findMedia(
    device: DeviceInfo,
    fileName: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  stageMedia(
    device: DeviceInfo,
    input: Readonly<{ mediaUri: string; remotePath: string }>,
    signal?: AbortSignal,
  ): Promise<boolean>;
  stagedFileSize(
    device: DeviceInfo,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
  pull(
    device: DeviceInfo,
    input: Readonly<{ remotePath: string; outputPath: string }>,
    signal?: AbortSignal,
  ): Promise<HostCommandResult>;
  remove(device: DeviceInfo, remotePath: string, signal?: AbortSignal): Promise<boolean>;
  removeMedia(device: DeviceInfo, mediaUri: string, signal?: AbortSignal): Promise<boolean>;
}>;

const SCREEN_RECORDER_ABILITY = 'com.huawei.hmos.screenrecorder';
const SCREEN_RECORDER_SERVICE_ABILITY = 'com.huawei.hmos.screenrecorder.ServiceExtAbility';

export function createHarmonyScreenRecorder(): HarmonyScreenRecorder {
  return Object.freeze({
    start: async (device, fileName, signal) =>
      await hdcShell(
        device,
        [
          'aa',
          'start',
          '-b',
          SCREEN_RECORDER_ABILITY,
          '-a',
          SCREEN_RECORDER_SERVICE_ABILITY,
          '--ps',
          'CustomizedFileName',
          fileName,
        ],
        signal,
      ),
    stop: async (device, signal) =>
      await hdcShell(
        device,
        ['aa', 'start', '-b', SCREEN_RECORDER_ABILITY, '-a', SCREEN_RECORDER_SERVICE_ABILITY],
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
  return await runHarmonyHdc(device, args, { allowFailure: true, signal });
}

async function hdcShell(device: DeviceInfo, words: readonly ShellWord[], signal?: AbortSignal) {
  return await runHarmonyShell(device, words, { allowFailure: true, signal });
}
