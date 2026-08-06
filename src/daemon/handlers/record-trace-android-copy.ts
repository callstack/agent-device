import fs from 'node:fs';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { sleep } from '../../utils/timeouts.ts';
import { androidDeviceForSerial } from '../../platforms/android/adb.ts';
import { pullAndroidAdbFile } from '../../platforms/android/adb-executor.ts';
import { formatRecordTraceExecFailure } from '../record-trace-errors.ts';
import type { SessionState } from '../types.ts';
import type { RecordTraceDeps } from './record-trace-types.ts';

// After `kill -2`, screenrecord needs 1-3s under load to finalize the MP4, and it does so by
// patching a front-reserved moov in place — the remote file size never changes, so the only way
// to observe finalization is to re-pull and validate. The escalating delays must outlast that
// finalization window with margin.
const ANDROID_LOCAL_VIDEO_RETRY_DELAYS_MS = [750, 1_500, 3_000];

type AndroidRecording = Extract<NonNullable<SessionState['recording']>, { platform: 'android' }>;

export async function copyAndroidRecordingChunksWithValidation(params: {
  deps: RecordTraceDeps;
  deviceId: string;
  chunks: NonNullable<AndroidRecording['chunks']>;
}): Promise<string | undefined> {
  for (const chunk of params.chunks) {
    const copyError = await copyAndroidRecordingWithValidation({
      deps: params.deps,
      deviceId: params.deviceId,
      remotePath: chunk.remotePath,
      outPath: chunk.path,
    });
    if (copyError) {
      return `failed to copy recording chunk ${chunk.index}: ${copyError}`;
    }
  }
  return undefined;
}

async function copyAndroidRecordingWithValidation(params: {
  deps: RecordTraceDeps;
  deviceId: string;
  remotePath: string;
  outPath: string;
}): Promise<string | undefined> {
  const { deps, deviceId, remotePath, outPath } = params;
  let lastCopyError: string | undefined;

  for (let attempt = 0; attempt <= ANDROID_LOCAL_VIDEO_RETRY_DELAYS_MS.length; attempt += 1) {
    const retryDelayMs = ANDROID_LOCAL_VIDEO_RETRY_DELAYS_MS[attempt - 1];
    if (retryDelayMs !== undefined) {
      await sleep(retryDelayMs);
    }
    removeLocalRecordingCandidate(outPath);

    const device = androidDeviceForSerial(deviceId);
    const pullResult = await pullAndroidAdbFile(remotePath, outPath, {
      allowFailure: true,
      device,
    });
    if (pullResult.exitCode !== 0) {
      lastCopyError = formatRecordTraceExecFailure(pullResult, 'adb pull');
      continue;
    }

    const playable = await deps.isPlayableVideo(outPath);
    emitDiagnostic({
      level: 'debug',
      phase: 'record_stop_android_pull_validation',
      data: {
        deviceId,
        remotePath,
        outPath,
        attempt: attempt + 1,
        fileSize: readFileSize(outPath),
        playable,
      },
    });
    if (playable) {
      return undefined;
    }

    emitDiagnostic({
      level: 'warn',
      phase: 'record_stop_android_invalid_video_retry',
      data: {
        deviceId,
        remotePath,
        outPath,
        attempt: attempt + 1,
      },
    });
  }

  if (lastCopyError) {
    return `failed to copy recording from device: ${lastCopyError}`;
  }
  removeLocalRecordingCandidate(outPath);
  return 'failed to copy recording from device: pulled file is not a playable MP4';
}

function readFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function removeLocalRecordingCandidate(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Ignore local cleanup issues and let the caller report the validation failure.
  }
}
