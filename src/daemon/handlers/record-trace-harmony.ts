import { randomUUID } from 'node:crypto';
import { AppError } from '@agent-device/kernel/errors';
import { runHarmonyHdc } from '../../platforms/harmonyos/hdc.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { SessionState } from '../types.ts';
import type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';
import { errorResponse } from './response.ts';

const HARMONY_SCREEN_RECORDER_BUNDLE = 'com.huawei.hmos.screenrecorder';
const HARMONY_SCREEN_RECORDER_ABILITY = 'com.huawei.hmos.screenrecorder.ServiceExtAbility';

type HarmonyRecording = Extract<NonNullable<SessionState['recording']>, { platform: 'harmonyos' }>;

export function parseHarmonyMediaUri(output: string): string | undefined {
  return output.match(/file:\/\/[^\s"']+/)?.[0];
}

export function parseHarmonyFileSize(output: string): number | undefined {
  const fields = output.trim().split(/\s+/);
  const size = Number(fields.at(-4));
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

export async function startHarmonyRecording(params: {
  device: SessionState['device'];
  recordingBase: RecordingBase;
}): Promise<HarmonyRecording | ReturnType<typeof errorResponse>> {
  const { device, recordingBase } = params;
  const fileName = `agent-device-recording-${randomUUID()}.mp4`;
  const start = await runHarmonyHdc(device, [
    'shell',
    'aa',
    'start',
    '-b',
    HARMONY_SCREEN_RECORDER_BUNDLE,
    '-a',
    HARMONY_SCREEN_RECORDER_ABILITY,
    '--ps',
    'CustomizedFileName',
    fileName,
  ]);
  if (!start.stdout.includes('start ability successfully')) {
    return errorResponse('COMMAND_FAILED', 'failed to start HarmonyOS screen recording', {
      output: start.stdout.trim(),
    });
  }
  return {
    ...recordingBase,
    platform: 'harmonyos',
    fileName,
    remotePath: `/data/local/tmp/${fileName}`,
  };
}

export async function stopHarmonyRecording(params: {
  deps: Pick<RecordTraceDeps, 'isPlayableVideo' | 'waitForStableFile'>;
  device: SessionState['device'];
  recording: HarmonyRecording;
}): Promise<ReturnType<typeof errorResponse> | null> {
  const { deps, device, recording } = params;
  let mediaUri: string | undefined;
  let copied = false;
  try {
    const stop = await runHarmonyHdc(device, [
      'shell',
      'aa',
      'start',
      '-b',
      HARMONY_SCREEN_RECORDER_BUNDLE,
      '-a',
      HARMONY_SCREEN_RECORDER_ABILITY,
    ]);
    if (!stop.stdout.includes('start ability successfully')) {
      return harmonyRecordingFailure('failed to stop HarmonyOS screen recording', stop.stdout);
    }

    const query = await runHarmonyHdc(device, [
      'shell',
      'mediatool',
      'query',
      recording.fileName,
      '-u',
    ]);
    mediaUri = parseHarmonyMediaUri(query.stdout);
    if (!mediaUri) {
      return harmonyRecordingFailure(
        `failed to find finalized HarmonyOS recording '${recording.fileName}'`,
        query.stdout,
      );
    }

    const mediaCopy = await copyHarmonyMediaToDevice({
      device,
      mediaUri,
      remotePath: recording.remotePath,
    });
    if (!mediaCopy.ready) {
      return errorResponse(
        'COMMAND_FAILED',
        `failed to finalize HarmonyOS recording: ${recording.fileName} did not produce a non-empty media file`,
        { lastStagingStatus: mediaCopy.lastStatus },
      );
    }
    await runHarmonyHdc(device, ['file', 'recv', recording.remotePath, recording.outPath]);
    await deps.waitForStableFile(recording.outPath);
    if (!(await waitForHarmonyPlayableVideo(recording.outPath, deps))) {
      return errorResponse(
        'COMMAND_FAILED',
        `failed to stop HarmonyOS recording: ${recording.outPath} was not finalized into a playable MP4; the retrieved file is retained for inspection`,
      );
    }
    copied = true;
    return null;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: `failed to finalize HarmonyOS recording: ${formatHarmonyRecordingError(error)}`,
        ...(mediaUri
          ? {
              hint: `The recording may remain in the device media library as ${mediaUri}. Retrieve or delete it with mediatool.`,
            }
          : {}),
      },
    };
  } finally {
    await runHarmonyHdc(device, ['shell', 'rm', '-f', recording.remotePath], {
      allowFailure: true,
    }).catch(() => {});
    if (copied && mediaUri) {
      await runHarmonyHdc(device, ['shell', 'mediatool', 'delete', mediaUri], {
        allowFailure: true,
      }).catch(() => {});
    }
  }
}

async function copyHarmonyMediaToDevice(params: {
  device: SessionState['device'];
  mediaUri: string;
  remotePath: string;
}): Promise<{ ready: boolean; lastStatus: string }> {
  const { device, mediaUri, remotePath } = params;
  let lastStatus = 'staging file was not listed';
  // ScreenRecorder publishes the media row before cloud-media finalization finishes.
  // API 24 hardware has taken several seconds to turn that row into readable bytes.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // mediatool leaves an initial zero-byte destination in place and does not
    // overwrite it on a later retry, so clear the device-side staging path first.
    await runHarmonyHdc(device, ['shell', 'rm', '-f', remotePath], { allowFailure: true });
    await runHarmonyHdc(device, ['shell', 'mediatool', 'recv', mediaUri, remotePath]);
    const stat = await runHarmonyHdc(device, ['shell', 'ls', '-l', remotePath], {
      allowFailure: true,
    });
    lastStatus = stat.stdout.trim() || stat.stderr.trim() || `hdc exit ${stat.exitCode}`;
    if (stat.exitCode === 0 && parseHarmonyFileSize(stat.stdout) !== undefined) {
      return { ready: true, lastStatus };
    }
    await sleep(250);
  }
  return { ready: false, lastStatus };
}

async function waitForHarmonyPlayableVideo(
  outPath: string,
  deps: Pick<RecordTraceDeps, 'isPlayableVideo'>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await deps.isPlayableVideo(outPath)) return true;
    await sleep(150);
  }
  return false;
}

function harmonyRecordingFailure(
  message: string,
  output: string,
): ReturnType<typeof errorResponse> {
  return errorResponse('COMMAND_FAILED', `${message}: ${output.trim() || 'no diagnostic output'}`);
}

function formatHarmonyRecordingError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
