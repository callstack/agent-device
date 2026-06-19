import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { sleep } from '../../utils/timeouts.ts';
import { androidDeviceForSerial, runAndroidAdb } from '../../platforms/android/adb.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { buildRecordStopFailure, formatRecordTraceExecFailure } from '../record-trace-errors.ts';
import type { RecordTraceDeps } from './record-trace-types.ts';
import { errorResponse } from './response.ts';
import type {
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
} from '../../platforms/android/adb-executor.ts';
import {
  ensureAndroidRecordingChunks,
  finalizeAndroidRecordingOutput,
  resolveAndroidScreenrecordLimitWarning,
  scheduleAndroidRecordingRotation,
} from './record-trace-android-chunks.ts';
import { copyAndroidRecordingChunksWithValidation } from './record-trace-android-copy.ts';
import {
  DEFAULT_RECORDING_EXPORT_QUALITY,
  type RecordingExportQuality,
} from '../../core/recording-export-quality.ts';

type AndroidRecordingSize = { width: number; height: number };

const ANDROID_RECORDING_BIT_RATE: Record<RecordingExportQuality, number> = {
  medium: 8_000_000,
  high: 20_000_000,
};

const ANDROID_REMOTE_FILE_POLL_MS = 250;
const ANDROID_REMOTE_FILE_ATTEMPTS = 20;
const ANDROID_REMOTE_FILE_STABLE_POLLS = 4;
const ANDROID_PROCESS_EXIT_POLL_MS = 250;
const ANDROID_PROCESS_EXIT_ATTEMPTS = 40;
const ANDROID_RECORDING_READY_ATTEMPTS = 8;
const ANDROID_RECORDING_READY_MIN_RUNNING_POLLS = 2;

type AndroidDevice = SessionState['device'];
type AndroidRecording = Extract<NonNullable<SessionState['recording']>, { platform: 'android' }>;
type AndroidRecordingBase = Pick<
  AndroidRecording,
  | 'outPath'
  | 'clientOutPath'
  | 'telemetryPath'
  | 'startedAt'
  | 'maxSize'
  | 'exportQuality'
  | 'showTouches'
  | 'gestureEvents'
>;

async function runAndroidRecordingAdb(
  deviceId: string,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await runAndroidAdb(androidDeviceForSerial(deviceId), args, options);
}

function parseAndroidRemotePid(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .at(-1);
}

async function isAndroidProcessRunning(deviceId: string, pid: string): Promise<boolean> {
  const result = await runAndroidRecordingAdb(deviceId, ['shell', 'ps', '-o', 'pid=', '-p', pid], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return false;
  }
  return result.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .includes(pid);
}

async function waitForAndroidProcessExit(deviceId: string, pid: string): Promise<boolean> {
  for (let attempt = 0; attempt < ANDROID_PROCESS_EXIT_ATTEMPTS; attempt += 1) {
    if (!(await isAndroidProcessRunning(deviceId, pid))) {
      return true;
    }
    await sleep(ANDROID_PROCESS_EXIT_POLL_MS);
  }
  return !(await isAndroidProcessRunning(deviceId, pid));
}

async function waitForAndroidRemoteFileStability(
  deviceId: string,
  remotePath: string,
): Promise<void> {
  let previousSize: string | undefined;
  let stableCount = 0;

  for (let attempt = 0; attempt < ANDROID_REMOTE_FILE_ATTEMPTS; attempt += 1) {
    const statResult = await runAndroidRecordingAdb(
      deviceId,
      ['shell', 'stat', '-c', '%s', remotePath],
      { allowFailure: true },
    );
    const currentSize = statResult.exitCode === 0 ? statResult.stdout.trim() : '';
    if (currentSize.length > 0 && currentSize === previousSize) {
      stableCount += 1;
      if (stableCount >= ANDROID_REMOTE_FILE_STABLE_POLLS) {
        return;
      }
    } else {
      stableCount = 0;
    }
    previousSize = currentSize;
    await sleep(ANDROID_REMOTE_FILE_POLL_MS);
  }
}

async function waitForAndroidRecordingReady(
  deviceId: string,
  remotePath: string,
  remotePid: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < ANDROID_RECORDING_READY_ATTEMPTS; attempt += 1) {
    const statResult = await runAndroidRecordingAdb(
      deviceId,
      ['shell', 'stat', '-c', '%s', remotePath],
      { allowFailure: true },
    );
    const currentSize = statResult.exitCode === 0 ? Number(statResult.stdout.trim()) : NaN;
    if (Number.isFinite(currentSize) && currentSize > 0) {
      return true;
    }

    if (!(await isAndroidProcessRunning(deviceId, remotePid))) {
      return false;
    }

    // Some Android builds keep the output file at zero bytes briefly after screenrecord starts.
    // Once the process stays alive for a couple of polls, treat recording as ready and let stop
    // validation handle final container/playability checks.
    if (attempt + 1 >= ANDROID_RECORDING_READY_MIN_RUNNING_POLLS) {
      return true;
    }

    await sleep(ANDROID_REMOTE_FILE_POLL_MS);
  }

  return false;
}

function androidRemoteRecordingPaths(timestamp: number, preferredDir?: string): string[] {
  const fileName = `agent-device-recording-${timestamp}.mp4`;
  const dirs = ['/sdcard', '/data/local/tmp'];
  const orderedDirs =
    preferredDir && dirs.includes(preferredDir)
      ? [preferredDir, ...dirs.filter((dir) => dir !== preferredDir)]
      : dirs;
  return orderedDirs.map((dir) => `${dir}/${fileName}`);
}

async function resolveAndroidRecordingSize(params: {
  deviceId: string;
  maxSize: number | undefined;
}): Promise<AndroidRecordingSize | undefined> {
  const { deviceId, maxSize } = params;
  if (maxSize === undefined) {
    return undefined;
  }

  const sizeResult = await runAndroidRecordingAdb(deviceId, ['shell', 'wm', 'size'], {
    allowFailure: true,
  });
  const match =
    sizeResult.stdout.match(/Override size:\s*(\d+)x(\d+)/) ??
    sizeResult.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (sizeResult.exitCode !== 0 || !match) {
    throw new Error(
      `failed to resolve Android screen size for recording max-size: ${formatRecordTraceExecFailure(sizeResult, 'adb shell wm size')}`,
    );
  }

  return scaledSizeToMax({
    width: Number(match[1]),
    height: Number(match[2]),
    maxSize,
  });
}

function scaledSizeToMax(size: AndroidRecordingSize & { maxSize: number }): AndroidRecordingSize {
  const longest = Math.max(size.width, size.height);
  if (longest <= size.maxSize) {
    return { width: size.width, height: size.height };
  }
  const scale = size.maxSize / longest;
  return {
    width: scaledEvenDimension(size.width, scale),
    height: scaledEvenDimension(size.height, scale),
  };
}

function scaledEvenDimension(value: number, scale: number): number {
  return Math.max(2, Math.round((value * scale) / 2) * 2);
}

function buildAndroidScreenrecordCommand(
  remotePath: string,
  size: AndroidRecordingSize | undefined,
  quality: RecordingExportQuality,
): string {
  const screenrecordArgs = ['screenrecord'];
  if (size) {
    screenrecordArgs.push('--size', `${size.width}x${size.height}`);
  }
  screenrecordArgs.push('--bit-rate', String(ANDROID_RECORDING_BIT_RATE[quality]));
  screenrecordArgs.push(remotePath);
  return `${screenrecordArgs.join(' ')} >/dev/null 2>&1 & echo $!`;
}

async function cleanupAndroidRemoteRecording(deviceId: string, remotePath: string): Promise<void> {
  await runAndroidRecordingAdb(deviceId, ['shell', 'rm', '-f', remotePath], {
    allowFailure: true,
  });
}

async function forceStopAndroidProcess(deviceId: string, pid: string): Promise<boolean> {
  const forceResult = await runAndroidRecordingAdb(deviceId, ['shell', 'kill', '-9', pid], {
    allowFailure: true,
  });
  emitDiagnostic({
    level: 'warn',
    phase: 'record_stop_android_force_signal',
    data: {
      deviceId,
      remotePid: pid,
      exitCode: forceResult.exitCode,
      stdout: forceResult.stdout.trim(),
      stderr: forceResult.stderr.trim(),
    },
  });
  if (forceResult.exitCode !== 0 && (await isAndroidProcessRunning(deviceId, pid))) {
    return false;
  }
  return await waitForAndroidProcessExit(deviceId, pid);
}

async function startAndroidScreenrecordChunk(params: {
  device: AndroidDevice;
  recordingSize: AndroidRecordingSize | undefined;
  quality: RecordingExportQuality;
  preferredRemoteDir?: string;
}): Promise<
  { remotePath: string; remotePid: string; startedAt: number } | { error: DaemonResponse }
> {
  const { device, recordingSize, quality, preferredRemoteDir } = params;
  let lastStartError =
    'failed to start recording: Android screenrecord did not begin producing frames';

  for (const remotePath of androidRemoteRecordingPaths(Date.now(), preferredRemoteDir)) {
    const startResult = await runAndroidRecordingAdb(
      device.id,
      ['shell', buildAndroidScreenrecordCommand(remotePath, recordingSize, quality)],
      {
        allowFailure: true,
      },
    );
    if (startResult.exitCode !== 0) {
      lastStartError = `failed to start recording: ${formatRecordTraceExecFailure(startResult, 'adb shell screenrecord')}`;
      continue;
    }

    const remotePid = parseAndroidRemotePid(startResult.stdout);
    if (!remotePid) {
      lastStartError =
        'failed to start recording: adb did not return a valid Android screenrecord pid';
      await cleanupAndroidRemoteRecording(device.id, remotePath);
      continue;
    }

    emitDiagnostic({
      level: 'debug',
      phase: 'record_start_android_started',
      data: {
        deviceId: device.id,
        remotePath,
        remotePid,
      },
    });

    if (await waitForAndroidRecordingReady(device.id, remotePath, remotePid)) {
      return {
        remotePath,
        remotePid,
        startedAt: Date.now(),
      };
    }

    lastStartError =
      'failed to start recording: Android screenrecord did not begin producing frames';
    await forceStopAndroidProcess(device.id, remotePid);
    await cleanupAndroidRemoteRecording(device.id, remotePath);
  }

  return { error: errorResponse('COMMAND_FAILED', lastStartError) };
}

export async function startAndroidRecording(params: {
  device: AndroidDevice;
  recordingBase: AndroidRecordingBase;
}): Promise<DaemonResponse | AndroidRecording> {
  const { device, recordingBase } = params;
  let recordingSize: AndroidRecordingSize | undefined;
  try {
    recordingSize = await resolveAndroidRecordingSize({
      deviceId: device.id,
      maxSize: recordingBase.maxSize,
    });
  } catch (error) {
    return errorResponse('COMMAND_FAILED', error instanceof Error ? error.message : String(error));
  }

  const quality = recordingBase.exportQuality ?? DEFAULT_RECORDING_EXPORT_QUALITY;
  const chunk = await startAndroidScreenrecordChunk({
    device,
    recordingSize,
    quality,
  });
  if ('error' in chunk) {
    return chunk.error;
  }

  const recording: AndroidRecording = {
    platform: 'android',
    remotePath: chunk.remotePath,
    remotePid: chunk.remotePid,
    chunks: [
      {
        index: 1,
        path: recordingBase.outPath,
        remotePath: chunk.remotePath,
      },
    ],
    ...recordingBase,
    startedAt: chunk.startedAt,
  };
  scheduleAndroidRecordingRotation({
    recording,
    finishCurrentChunk: async () =>
      await finishCurrentAndroidRecordingChunk({
        device,
        recording,
        waitForRemoteFileStability: false,
      }),
    startNextChunk: async (preferredRemoteDir) => {
      const nextChunk = await startAndroidScreenrecordChunk({
        device,
        recordingSize,
        quality,
        preferredRemoteDir,
      });
      if ('error' in nextChunk) {
        throw new Error(
          nextChunk.error.ok
            ? 'failed to start next Android recording chunk'
            : nextChunk.error.error.message,
        );
      }
      return nextChunk;
    },
  });
  return recording;
}

async function finishCurrentAndroidRecordingChunk(params: {
  device: AndroidDevice;
  recording: AndroidRecording;
  waitForRemoteFileStability?: boolean;
}): Promise<string | undefined> {
  const { device, recording, waitForRemoteFileStability = true } = params;
  const wasRunningBeforeStop = await isAndroidProcessRunning(device.id, recording.remotePid);
  if (!wasRunningBeforeStop) {
    recording.warning ??= resolveAndroidScreenrecordLimitWarning(recording);
  }

  const stopResult = await runAndroidRecordingAdb(
    device.id,
    ['shell', 'kill', '-2', recording.remotePid],
    {
      allowFailure: true,
    },
  );
  emitDiagnostic({
    level: 'debug',
    phase: 'record_stop_android_signal',
    data: {
      deviceId: device.id,
      remotePath: recording.remotePath,
      remotePid: recording.remotePid,
      exitCode: stopResult.exitCode,
      stdout: stopResult.stdout.trim(),
      stderr: stopResult.stderr.trim(),
    },
  });

  if (stopResult.exitCode !== 0) {
    return await recoverAndroidStopSignalFailure(device.id, recording.remotePid, stopResult);
  }
  const exitError = await waitForAndroidStopExit(device.id, recording.remotePid);
  if (exitError) {
    return exitError;
  }

  if (waitForRemoteFileStability) {
    await waitForAndroidRemoteFileStability(device.id, recording.remotePath);
  }
  return undefined;
}

async function recoverAndroidStopSignalFailure(
  deviceId: string,
  remotePid: string,
  stopResult: AndroidAdbExecutorResult,
): Promise<string | undefined> {
  if (!(await isAndroidProcessRunning(deviceId, remotePid))) {
    return undefined;
  }
  if (await forceStopAndroidProcess(deviceId, remotePid)) {
    return undefined;
  }
  return `failed to stop recording: ${formatRecordTraceExecFailure(stopResult, 'adb shell kill')}`;
}

async function waitForAndroidStopExit(
  deviceId: string,
  remotePid: string,
): Promise<string | undefined> {
  if (await waitForAndroidProcessExit(deviceId, remotePid)) {
    return undefined;
  }
  if (await forceStopAndroidProcess(deviceId, remotePid)) {
    return undefined;
  }
  return `failed to stop recording: Android screenrecord pid ${remotePid} did not exit`;
}

export async function stopAndroidRecording(params: {
  deps: RecordTraceDeps;
  device: AndroidDevice;
  recording: AndroidRecording;
  stopRequestedAt: number;
}): Promise<DaemonResponse | null> {
  const { deps, device, recording, stopRequestedAt } = params;
  emitDiagnostic({
    level: 'debug',
    phase: 'record_stop_android_enter',
    data: {
      deviceId: device.id,
      remotePath: recording.remotePath,
      remotePid: recording.remotePid,
    },
  });
  recording.stopping = true;
  if (recording.rotationTimer) {
    clearTimeout(recording.rotationTimer);
    recording.rotationTimer = undefined;
  }
  await recording.rotationPromise;
  const stopError = await finishCurrentAndroidRecordingChunk({ device, recording });
  if (recording.rotationFailedReason && !stopError) {
    recording.warning ??= `Android recording chunk rotation failed: ${recording.rotationFailedReason}`;
  }
  let cleanupError: string | undefined;

  if (!stopError) {
    const copyError = await copyAndroidRecordingChunksWithValidation({
      deps,
      deviceId: device.id,
      chunks: ensureAndroidRecordingChunks(recording),
    });
    if (copyError) {
      await cleanupRemoteRecording();
      return errorResponse(
        'COMMAND_FAILED',
        formatAndroidStopFailure(copyError, recording, stopRequestedAt),
      );
    }

    await finalizeAndroidRecordingOutput({ recording, deps });
  }

  await cleanupRemoteRecording();

  if (stopError) {
    return errorResponse(
      'COMMAND_FAILED',
      formatAndroidStopFailure(stopError, recording, stopRequestedAt),
    );
  }

  if (cleanupError) {
    return errorResponse('COMMAND_FAILED', cleanupError);
  }

  return null;

  async function cleanupRemoteRecording(): Promise<void> {
    for (const chunk of ensureAndroidRecordingChunks(recording)) {
      const rmResult = await runAndroidRecordingAdb(
        device.id,
        ['shell', 'rm', '-f', chunk.remotePath],
        {
          allowFailure: true,
        },
      );
      emitDiagnostic({
        level: 'debug',
        phase: 'record_stop_android_cleanup',
        data: {
          deviceId: device.id,
          remotePath: chunk.remotePath,
          exitCode: rmResult.exitCode,
          stdout: rmResult.stdout.trim(),
          stderr: rmResult.stderr.trim(),
        },
      });
      if (rmResult.exitCode !== 0 && !stopError) {
        cleanupError = `failed to clean up remote recording: ${formatRecordTraceExecFailure(rmResult, 'adb shell rm')}`;
      }
    }
  }
}

function formatAndroidStopFailure(
  error: string,
  recording: AndroidRecording,
  stopRequestedAt: number,
): string {
  return buildRecordStopFailure(error, recording, stopRequestedAt).message;
}
