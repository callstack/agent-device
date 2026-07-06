import path from 'node:path';
import { androidDeviceForSerial, runAndroidAdb } from '../../platforms/android/adb.ts';
import type {
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
} from '../../platforms/android/adb-executor.ts';
import { shellQuote } from '../../utils/shell-quote.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { errorResponse } from './response.ts';

const ANDROID_RECOVERY_WARNING =
  'Recovered Android recording after daemon recording state was missing; gesture overlays and earlier rotated chunks may be unavailable.';
const ANDROID_RECOVERY_METADATA_FILE = 'agent-device-recording-active.json';
const ANDROID_RECOVERY_PROBE_TIMEOUT_MS = 5_000;
const ANDROID_RECOVERY_METADATA_DIRS = ['/sdcard', '/data/local/tmp'] as const;

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

type AndroidRecordingRecoveryMetadata = {
  remotePath: string;
  remotePid: string;
  startedAt: number;
};

async function runAndroidRecoveryAdb(
  deviceId: string,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await runAndroidAdb(androidDeviceForSerial(deviceId), args, options);
}

function parseRecoverableAndroidScreenrecord(
  line: string,
): AndroidRecordingRecoveryMetadata | undefined {
  const match = line
    .trim()
    .match(
      /^(\d+)\s+.*\bscreenrecord\b.*(\/(?:sdcard|data\/local\/tmp)\/agent-device-recording-(\d+)\.mp4)(?:\s|$)/,
    );
  if (!match) {
    return undefined;
  }
  const [, remotePid, remotePath, timestamp] = match;
  if (!remotePid || !remotePath) {
    return undefined;
  }
  const startedAt = Number(timestamp);
  return {
    remotePid,
    remotePath,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
  };
}

function parseAndroidRecoveryMetadata(value: string): AndroidRecordingRecoveryMetadata | undefined {
  const metadata = parseAndroidRecoveryMetadataObject(value);
  if (!metadata) {
    return undefined;
  }
  const remotePid = parseAndroidRecoveryRemotePid(metadata.remotePid);
  const remotePath = parseAndroidRecoveryRemotePath(metadata.remotePath);
  if (!remotePid || !remotePath) {
    return undefined;
  }
  return {
    remotePid,
    remotePath,
    startedAt: parseAndroidRecoveryStartedAt(metadata.startedAt),
  };
}

function parseAndroidRecoveryMetadataObject(value: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function parseAndroidRecoveryRemotePid(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}

function parseAndroidRecoveryRemotePath(value: unknown): string | undefined {
  return typeof value === 'string' && isAndroidAgentRecordingPath(value) ? value : undefined;
}

function parseAndroidRecoveryStartedAt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function isAndroidAgentRecordingPath(remotePath: string): boolean {
  return /^\/(?:sdcard|data\/local\/tmp)\/agent-device-recording-\d+\.mp4$/.test(remotePath);
}

function androidRecoveryMetadataPathForRemotePath(remotePath: string): string {
  return `${path.posix.dirname(remotePath)}/${ANDROID_RECOVERY_METADATA_FILE}`;
}

function androidRecoveryMetadataPaths(): string[] {
  return ANDROID_RECOVERY_METADATA_DIRS.map((dir) => `${dir}/${ANDROID_RECOVERY_METADATA_FILE}`);
}

async function readAndroidRecoveryMetadata(
  deviceId: string,
): Promise<AndroidRecordingRecoveryMetadata | undefined> {
  for (const metadataPath of androidRecoveryMetadataPaths()) {
    const result = await runAndroidRecoveryAdb(deviceId, ['shell', 'cat', metadataPath], {
      allowFailure: true,
      timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      continue;
    }
    const metadata = parseAndroidRecoveryMetadata(result.stdout);
    if (!metadata) {
      await cleanupAndroidRecoveryMetadataPath({
        deviceId,
        metadataPath,
        phase: 'record_stop_android_recovery_metadata_invalid_cleanup_failed',
      });
      continue;
    }
    const liveness = await checkLiveRecoverableAndroidScreenrecord(deviceId, metadata);
    if (liveness === 'live') {
      return metadata;
    }
    if (liveness === 'uncertain') {
      continue;
    }
    await cleanupAndroidRecoveryMetadataPath({
      deviceId,
      metadataPath,
      phase: 'record_stop_android_recovery_metadata_stale_cleanup_failed',
    });
  }
  return undefined;
}

async function checkLiveRecoverableAndroidScreenrecord(
  deviceId: string,
  metadata: AndroidRecordingRecoveryMetadata,
): Promise<'live' | 'stale' | 'uncertain'> {
  const result = await runAndroidRecoveryAdb(
    deviceId,
    ['shell', 'ps', '-o', 'pid=,args=', '-p', metadata.remotePid],
    {
      allowFailure: true,
      timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
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
  const sawPid = result.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(metadata.remotePid));
  const matched = result.stdout
    .split(/\r?\n/)
    .map(parseRecoverableAndroidScreenrecord)
    .some(
      (candidate) =>
        candidate?.remotePid === metadata.remotePid && candidate.remotePath === metadata.remotePath,
    );
  if (matched) {
    return 'live';
  }
  return sawPid ? 'uncertain' : 'stale';
}

async function findRecoverableAndroidScreenrecord(
  deviceId: string,
): Promise<AndroidRecordingRecoveryMetadata | DaemonResponse | undefined> {
  const result = await runAndroidRecoveryAdb(deviceId, ['shell', 'ps', '-A', '-o', 'pid=,args='], {
    allowFailure: true,
    timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    emitDiagnostic({
      level: 'debug',
      phase: 'record_stop_android_recovery_ps_failed',
      data: {
        deviceId,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
    });
    return undefined;
  }

  const matches = result.stdout
    .split(/\r?\n/)
    .map(parseRecoverableAndroidScreenrecord)
    .filter((match): match is NonNullable<typeof match> => match !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    return errorResponse(
      'INVALID_ARGS',
      'multiple active Android screenrecord processes match agent-device recordings; cannot safely recover missing recording state',
      { processes: matches.map(({ remotePid, remotePath }) => ({ remotePid, remotePath })) },
    );
  }
  return matches[0];
}

export async function writeAndroidRecoveryMetadata(
  deviceId: string,
  metadata: AndroidRecordingRecoveryMetadata,
): Promise<void> {
  const metadataPath = androidRecoveryMetadataPathForRemotePath(metadata.remotePath);
  const payload = JSON.stringify(metadata);
  const result = await runAndroidRecoveryAdb(
    deviceId,
    ['shell', `printf %s ${shellQuote(payload)} > ${shellQuote(metadataPath)}`],
    {
      allowFailure: true,
      timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    emitDiagnostic({
      level: 'warn',
      phase: 'record_start_android_recovery_metadata_failed',
      data: {
        deviceId,
        metadataPath,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
    });
    return;
  }

  for (const staleMetadataPath of androidRecoveryMetadataPaths()) {
    if (staleMetadataPath !== metadataPath) {
      await cleanupAndroidRecoveryMetadataPath({
        deviceId,
        metadataPath: staleMetadataPath,
        phase: 'record_start_android_recovery_metadata_stale_cleanup_failed',
      });
    }
  }
}

export async function cleanupAndroidRecoveryMetadata(deviceId: string): Promise<void> {
  for (const metadataPath of androidRecoveryMetadataPaths()) {
    await cleanupAndroidRecoveryMetadataPath({
      deviceId,
      metadataPath,
      phase: 'record_stop_android_recovery_metadata_cleanup_failed',
    });
  }
}

async function cleanupAndroidRecoveryMetadataPath(params: {
  deviceId: string;
  metadataPath: string;
  phase: string;
}): Promise<void> {
  const { deviceId, metadataPath, phase } = params;
  const result = await runAndroidRecoveryAdb(deviceId, ['shell', 'rm', '-f', metadataPath], {
    allowFailure: true,
    timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    emitDiagnostic({
      level: 'warn',
      phase,
      data: {
        deviceId,
        metadataPath,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
    });
  }
}

export async function recoverMissingAndroidRecording(params: {
  device: AndroidDevice;
  recordingBase: AndroidRecordingBase;
}): Promise<DaemonResponse | AndroidRecording | null> {
  const { device, recordingBase } = params;
  const recovered =
    (await readAndroidRecoveryMetadata(device.id)) ??
    (await findRecoverableAndroidScreenrecord(device.id));
  if (!recovered) {
    return null;
  }
  if ('ok' in recovered) {
    return recovered;
  }

  emitDiagnostic({
    level: 'warn',
    phase: 'record_stop_android_recovered_missing_state',
    data: {
      deviceId: device.id,
      remotePath: recovered.remotePath,
      remotePid: recovered.remotePid,
      outPath: recordingBase.outPath,
    },
  });

  return {
    platform: 'android',
    remotePath: recovered.remotePath,
    remotePid: recovered.remotePid,
    chunks: [
      {
        index: 1,
        path: recordingBase.outPath,
        remotePath: recovered.remotePath,
      },
    ],
    ...recordingBase,
    startedAt: recovered.startedAt,
    warning: ANDROID_RECOVERY_WARNING,
  };
}
