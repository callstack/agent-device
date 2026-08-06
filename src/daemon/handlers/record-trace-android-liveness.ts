import { androidDeviceForSerial, runAndroidAdb } from '../../platforms/android/adb.ts';
import type {
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
} from '../../platforms/android/adb-executor.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import {
  parseRecoverableAndroidScreenrecord,
  type AndroidRecordingRecoveryMetadata,
} from './record-trace-android-recovery-manifest.ts';

const ANDROID_LIVENESS_PROBE_TIMEOUT_MS = 5_000;
const ANDROID_LIVENESS_STAT_MIN_SIZE_BYTES = 1;

type AndroidScreenrecordLiveness = 'live' | 'stale' | 'uncertain' | 'finished';
export type AndroidScreenrecordProbe = AndroidRecordingRecoveryMetadata | 'uncertain' | undefined;

async function runAndroidLivenessAdb(
  deviceId: string,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await runAndroidAdb(androidDeviceForSerial(deviceId), args, options);
}

export async function checkRecoverableAndroidScreenrecord(
  deviceId: string,
  metadata: AndroidRecordingRecoveryMetadata,
): Promise<AndroidScreenrecordLiveness> {
  const result = await runAndroidLivenessAdb(
    deviceId,
    ['shell', 'ps', '-o', 'pid=,args=', '-p', metadata.remotePid],
    {
      allowFailure: true,
      timeoutMs: ANDROID_LIVENESS_PROBE_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    // toybox `ps -p <missing-pid>` exits non-zero with no output at all — the normal signature
    // of an exited process, not an adb failure (transport failures leave stderr and exec-layer
    // timeouts throw before this branch). Corroborate with the full process list so a healthy
    // device recovers the finished recording while a broken transport stays uncertain.
    if (result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
      return await resolveExitedAndroidScreenrecord(deviceId, metadata);
    }
    emitDiagnostic({
      level: 'debug',
      phase: 'record_stop_android_recovery_metadata_probe_uncertain',
      data: {
        deviceId,
        remotePid: metadata.remotePid,
        remotePath: metadata.remotePath,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
    });
    return 'uncertain';
  }
  const lines = result.stdout.split(/\r?\n/);
  const pidLine = lines
    .map((line) => line.trim())
    .find((line) => line.startsWith(metadata.remotePid));
  const matched = lines
    .map(parseRecoverableAndroidScreenrecord)
    .some(
      (candidate) =>
        candidate?.remotePid === metadata.remotePid && candidate.remotePath === metadata.remotePath,
    );
  if (matched) {
    return 'live';
  }
  if (pidLine?.includes('screenrecord')) return 'uncertain';
  if (pidLine) return 'stale';
  return (await androidRemoteFileExists(deviceId, metadata.remotePath)) ? 'finished' : 'stale';
}

async function resolveExitedAndroidScreenrecord(
  deviceId: string,
  metadata: AndroidRecordingRecoveryMetadata,
): Promise<AndroidScreenrecordLiveness> {
  const listed = await findLiveAndroidScreenrecordByPath(deviceId, metadata.remotePath);
  if (listed === 'uncertain') {
    return 'uncertain';
  }
  if (listed) {
    return listed.remotePid === metadata.remotePid ? 'live' : 'uncertain';
  }
  return (await androidRemoteFileExists(deviceId, metadata.remotePath)) ? 'finished' : 'stale';
}

export async function findLiveAndroidScreenrecordByPath(
  deviceId: string,
  remotePath: string,
): Promise<AndroidScreenrecordProbe> {
  const result = await runAndroidLivenessAdb(deviceId, ['shell', 'ps', '-A', '-o', 'pid=,args='], {
    allowFailure: true,
    timeoutMs: ANDROID_LIVENESS_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    emitDiagnostic({
      level: 'debug',
      phase: 'record_stop_android_recovery_ps_failed',
      data: {
        deviceId,
        remotePath,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
    });
    return 'uncertain';
  }

  return result.stdout
    .split(/\r?\n/)
    .map(parseRecoverableAndroidScreenrecord)
    .find((match): match is NonNullable<typeof match> => match?.remotePath === remotePath);
}

export async function androidRemoteFileExists(
  deviceId: string,
  remotePath: string,
): Promise<boolean> {
  const result = await runAndroidLivenessAdb(deviceId, ['shell', 'stat', '-c', '%s', remotePath], {
    allowFailure: true,
    timeoutMs: ANDROID_LIVENESS_PROBE_TIMEOUT_MS,
  });
  const size = result.exitCode === 0 ? Number(result.stdout.trim()) : NaN;
  return Number.isFinite(size) && size >= ANDROID_LIVENESS_STAT_MIN_SIZE_BYTES;
}
