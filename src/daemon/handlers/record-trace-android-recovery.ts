import path from 'node:path';
import { androidDeviceForSerial, runAndroidAdb } from '../../platforms/android/adb.ts';
import type {
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
} from '../../platforms/android/adb-executor.ts';
import { shellQuote } from '../../utils/shell-quote.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { DaemonResponse, RecordingChunk, SessionState } from '../types.ts';
import { errorResponse } from './response.ts';
import type { RecordingExportQuality } from '../../core/recording-export-quality.ts';

const ANDROID_RECOVERY_WARNING =
  'Recovered Android recording after daemon restart from durable device manifest.';
const ANDROID_RECOVERY_OVERLAY_WARNING =
  'touch overlay burn-in is unavailable after daemon restart because gesture telemetry is stored in daemon memory';
const ANDROID_OWNERLESS_RECOVERY_WARNING =
  'Recovered Android recording from a live screenrecord process without a durable manifest; session ownership, gesture overlays, and earlier rotated chunks could not be validated.';
const ANDROID_RECOVERY_METADATA_FILE = 'agent-device-recording-active.json';
const ANDROID_RECOVERY_PROBE_TIMEOUT_MS = 5_000;
const ANDROID_RECOVERY_METADATA_DIRS = ['/sdcard', '/data/local/tmp'] as const;
const ANDROID_RECOVERY_MANIFEST_VERSION = 1;

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

type AndroidRecordingRecoveryManifest = {
  version: 1;
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  recordingId: string;
  deviceId: string;
  startedAt: number;
  outPath: string;
  clientOutPath?: string;
  telemetryPath?: string;
  maxSize?: number;
  exportQuality?: RecordingExportQuality;
  showTouches: boolean;
  current: AndroidRecordingRecoveryMetadata;
  chunks: RecordingChunk[];
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

function parseAndroidRecoveryManifest(value: string): AndroidRecordingRecoveryManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const metadata = parsed as Record<string, unknown>;
  const current = metadata.current;
  if (
    metadata.version !== ANDROID_RECOVERY_MANIFEST_VERSION ||
    typeof metadata.sessionName !== 'string' ||
    typeof metadata.recordingId !== 'string' ||
    typeof metadata.deviceId !== 'string' ||
    typeof metadata.startedAt !== 'number' ||
    !Number.isFinite(metadata.startedAt) ||
    typeof metadata.outPath !== 'string' ||
    typeof metadata.showTouches !== 'boolean' ||
    !current ||
    typeof current !== 'object' ||
    !Array.isArray(metadata.chunks)
  ) {
    return undefined;
  }
  const parsedCurrent = parseAndroidRecoveryMetadata(current);
  if (!parsedCurrent) return undefined;
  const chunks = metadata.chunks
    .map(parseAndroidRecordingChunk)
    .filter((chunk): chunk is RecordingChunk => chunk !== undefined);
  if (chunks.length === 0 || chunks.length !== metadata.chunks.length) {
    return undefined;
  }

  return {
    version: ANDROID_RECOVERY_MANIFEST_VERSION,
    sessionName: metadata.sessionName,
    sessionScope: parseSessionScope(metadata.sessionScope),
    recordingId: metadata.recordingId,
    deviceId: metadata.deviceId,
    startedAt: metadata.startedAt,
    outPath: metadata.outPath,
    clientOutPath: readOptionalString(metadata.clientOutPath),
    telemetryPath: readOptionalString(metadata.telemetryPath),
    maxSize: readOptionalNumber(metadata.maxSize),
    exportQuality: parseRecordingExportQuality(metadata.exportQuality),
    showTouches: metadata.showTouches,
    current: parsedCurrent,
    chunks,
  };
}

function parseAndroidRecoveryMetadata(
  value: unknown,
): AndroidRecordingRecoveryMetadata | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const metadata = value as Partial<AndroidRecordingRecoveryMetadata>;
  if (
    typeof metadata.remotePid !== 'string' ||
    !/^\d+$/.test(metadata.remotePid) ||
    typeof metadata.remotePath !== 'string' ||
    !isAndroidAgentRecordingPath(metadata.remotePath)
  ) {
    return undefined;
  }
  return {
    remotePid: metadata.remotePid,
    remotePath: metadata.remotePath,
    startedAt:
      typeof metadata.startedAt === 'number' && Number.isFinite(metadata.startedAt)
        ? metadata.startedAt
        : Date.now(),
  };
}

function parseAndroidRecordingChunk(value: unknown): RecordingChunk | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const chunk = value as Partial<RecordingChunk>;
  if (
    typeof chunk.index !== 'number' ||
    !Number.isInteger(chunk.index) ||
    chunk.index < 1 ||
    typeof chunk.path !== 'string' ||
    typeof chunk.remotePath !== 'string' ||
    !isAndroidAgentRecordingPath(chunk.remotePath)
  ) {
    return undefined;
  }
  return {
    index: chunk.index,
    path: chunk.path,
    remotePath: chunk.remotePath,
  };
}

function parseSessionScope(value: unknown): SessionState['sessionScope'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const scope = value as Partial<NonNullable<SessionState['sessionScope']>>;
  if (scope.kind !== 'cwd' || typeof scope.id !== 'string') return undefined;
  return { kind: 'cwd', id: scope.id };
}

function parseRecordingExportQuality(value: unknown): RecordingExportQuality | undefined {
  return value === 'medium' || value === 'high' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
): Promise<AndroidRecordingRecoveryManifest[]> {
  const manifests: AndroidRecordingRecoveryManifest[] = [];
  for (const metadataPath of androidRecoveryMetadataPaths()) {
    const result = await runAndroidRecoveryAdb(deviceId, ['shell', 'cat', metadataPath], {
      allowFailure: true,
      timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      continue;
    }
    const metadata = parseAndroidRecoveryManifest(result.stdout);
    if (!metadata) {
      await cleanupAndroidRecoveryMetadataPath({
        deviceId,
        metadataPath,
        phase: 'record_stop_android_recovery_metadata_invalid_cleanup_failed',
      });
      continue;
    }
    if (metadata.deviceId !== deviceId) {
      await cleanupAndroidRecoveryMetadataPath({
        deviceId,
        metadataPath,
        phase: 'record_stop_android_recovery_metadata_device_mismatch_cleanup_failed',
      });
      continue;
    }
    const liveness = await checkLiveRecoverableAndroidScreenrecord(deviceId, metadata.current);
    if (liveness === 'live') {
      manifests.push(metadata);
      continue;
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
  return manifests;
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

export async function writeAndroidRecoveryMetadata(params: {
  deviceId: string;
  activeSession: SessionState;
  recording: AndroidRecording;
}): Promise<void> {
  const { deviceId, activeSession, recording } = params;
  const metadataPath = androidRecoveryMetadataPathForRemotePath(recording.remotePath);
  const manifest = buildAndroidRecoveryManifest({ deviceId, activeSession, recording });
  const payload = JSON.stringify(manifest);
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

function buildAndroidRecoveryManifest(params: {
  deviceId: string;
  activeSession: SessionState;
  recording: AndroidRecording;
}): AndroidRecordingRecoveryManifest {
  const { deviceId, activeSession, recording } = params;
  return {
    version: ANDROID_RECOVERY_MANIFEST_VERSION,
    sessionName: activeSession.name,
    sessionScope: activeSession.sessionScope,
    recordingId:
      recording.recordingId ??
      `android-${recording.remotePid}-${recording.remoteStartedAt ?? recording.startedAt}`,
    deviceId,
    startedAt: recording.startedAt,
    outPath: recording.outPath,
    clientOutPath: recording.clientOutPath,
    telemetryPath: recording.telemetryPath,
    maxSize: recording.maxSize,
    exportQuality: recording.exportQuality,
    showTouches: recording.showTouches,
    current: {
      remotePath: recording.remotePath,
      remotePid: recording.remotePid,
      startedAt: recording.remoteStartedAt ?? recording.startedAt,
    },
    chunks: recording.chunks ?? [
      {
        index: 1,
        path: recording.outPath,
        remotePath: recording.remotePath,
      },
    ],
  };
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
  activeSession: SessionState;
  device: AndroidDevice;
  recordingBase: AndroidRecordingBase;
}): Promise<DaemonResponse | AndroidRecording | null> {
  const { activeSession, device, recordingBase } = params;
  const manifests = await readAndroidRecoveryMetadata(device.id);
  if (manifests.length > 0) {
    return recoverAndroidRecordingFromManifest({ activeSession, device, manifests });
  }

  const recovered = await findRecoverableAndroidScreenrecord(device.id);
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
    recordingId: `recovered-${recovered.remotePid}-${recovered.startedAt}`,
    remotePath: recovered.remotePath,
    remotePid: recovered.remotePid,
    remoteStartedAt: recovered.startedAt,
    chunks: [
      {
        index: 1,
        path: recordingBase.outPath,
        remotePath: recovered.remotePath,
      },
    ],
    ...recordingBase,
    startedAt: recovered.startedAt,
    showTouches: false,
    warning: ANDROID_OWNERLESS_RECOVERY_WARNING,
  };
}

function recoverAndroidRecordingFromManifest(params: {
  activeSession: SessionState;
  device: AndroidDevice;
  manifests: AndroidRecordingRecoveryManifest[];
}): DaemonResponse | AndroidRecording {
  const { activeSession, device, manifests } = params;
  const matches = manifests.filter((manifest) =>
    androidRecoveryManifestMatchesSession(manifest, activeSession),
  );
  if (matches.length === 0) {
    return errorResponse('INVALID_ARGS', formatAndroidRecordingOwnerMismatch(manifests), {
      activeRecordings: manifests.map((manifest) => ({
        sessionName: manifest.sessionName,
        sessionScope: manifest.sessionScope,
        recordingId: manifest.recordingId,
        remotePid: manifest.current.remotePid,
        remotePath: manifest.current.remotePath,
      })),
    });
  }
  if (matches.length > 1 || manifests.length > 1) {
    return errorResponse(
      'INVALID_ARGS',
      'multiple active Android recording manifests exist; cannot safely recover missing recording state',
      {
        activeRecordings: manifests.map((manifest) => ({
          sessionName: manifest.sessionName,
          sessionScope: manifest.sessionScope,
          recordingId: manifest.recordingId,
          remotePid: manifest.current.remotePid,
          remotePath: manifest.current.remotePath,
        })),
      },
    );
  }

  const manifest = matches[0]!;
  emitDiagnostic({
    level: 'warn',
    phase: 'record_stop_android_recovered_missing_state',
    data: {
      deviceId: device.id,
      sessionName: manifest.sessionName,
      recordingId: manifest.recordingId,
      remotePath: manifest.current.remotePath,
      remotePid: manifest.current.remotePid,
      outPath: manifest.outPath,
      chunks: manifest.chunks.length,
    },
  });

  return {
    platform: 'android',
    recordingId: manifest.recordingId,
    remotePath: manifest.current.remotePath,
    remotePid: manifest.current.remotePid,
    remoteStartedAt: manifest.current.startedAt,
    chunks: manifest.chunks,
    outPath: manifest.outPath,
    clientOutPath: manifest.clientOutPath,
    telemetryPath: manifest.telemetryPath,
    startedAt: manifest.startedAt,
    maxSize: manifest.maxSize,
    exportQuality: manifest.exportQuality,
    showTouches: false,
    gestureEvents: [],
    warning: manifest.showTouches
      ? `${ANDROID_RECOVERY_WARNING} ${ANDROID_RECOVERY_OVERLAY_WARNING}.`
      : ANDROID_RECOVERY_WARNING,
    overlayWarning: manifest.showTouches ? ANDROID_RECOVERY_OVERLAY_WARNING : undefined,
  };
}

function androidRecoveryManifestMatchesSession(
  manifest: AndroidRecordingRecoveryManifest,
  activeSession: SessionState,
): boolean {
  return (
    manifest.sessionName === activeSession.name &&
    sessionScopesEqual(manifest.sessionScope, activeSession.sessionScope)
  );
}

function sessionScopesEqual(
  left: SessionState['sessionScope'] | undefined,
  right: SessionState['sessionScope'] | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind && left.id === right.id;
}

function formatAndroidRecordingOwnerMismatch(
  manifests: AndroidRecordingRecoveryManifest[],
): string {
  if (manifests.length === 1) {
    return `active Android recording belongs to session "${manifests[0]!.sessionName}"; run record stop --session ${manifests[0]!.sessionName} to recover it`;
  }
  return 'active Android recordings belong to other sessions; cannot safely recover missing recording state';
}
