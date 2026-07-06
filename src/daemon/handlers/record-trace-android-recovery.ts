import { androidDeviceForSerial, runAndroidAdb } from '../../platforms/android/adb.ts';
import type {
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
} from '../../platforms/android/adb-executor.ts';
import { shellQuote } from '../../utils/shell-quote.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { formatRecordTraceExecFailure } from '../record-trace-errors.ts';
import { errorResponse } from './response.ts';
import { deriveAndroidChunkOutPath } from './record-trace-android-chunks.ts';
import {
  androidRecoveryMetadataPathForRemotePath,
  androidRecoveryMetadataPaths,
  buildAndroidRecoveryManifest,
  buildAndroidRecoveryPendingManifest,
  buildAndroidRecoveryRotatingManifest,
  parseAndroidRecoveryManifest,
  parseRecoverableAndroidScreenrecord,
  type AndroidRecordingRecoveryChunk,
  type AndroidRecordingRecoveryManifest,
  type AndroidRecordingRecoveryMetadata,
} from './record-trace-android-recovery-manifest.ts';

const ANDROID_RECOVERY_WARNING =
  'Recovered Android recording after daemon restart from durable device manifest.';
const ANDROID_RECOVERY_OVERLAY_WARNING =
  'touch overlay burn-in is unavailable after daemon restart because gesture telemetry is stored in daemon memory';
const ANDROID_RECOVERY_FINISHED_WARNING =
  'Recovered Android recording after daemon restart from durable device manifest; the screenrecord process was no longer running, so the MP4 may be truncated.';
const ANDROID_RECOVERY_ROTATION_WARNING =
  'Recovered Android recording from an interrupted chunk rotation; returning chunks known to be safely owned by the durable manifest.';
const ANDROID_RECOVERY_MANIFEST_STAT_SIZE_BYTES = 1;
const ANDROID_RECOVERY_PROBE_TIMEOUT_MS = 5_000;

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

type AndroidRecordingRecoveryCandidate = Omit<
  AndroidRecordingRecoveryManifest,
  'current' | 'chunks'
> & {
  current: AndroidRecordingRecoveryMetadata;
  chunks: AndroidRecordingRecoveryChunk[];
  recoveryWarning?: string;
};

type AndroidRecoveryManifestScan = {
  live: AndroidRecordingRecoveryCandidate[];
  uncertain: AndroidRecordingRecoveryManifest[];
  blocked: AndroidRecoveryBlockedManifest[];
};

type AndroidRecoveryBlockedManifest = {
  metadataPath: string;
  reason: string;
};

type AndroidActiveRecordingSummary = {
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  recordingId: string;
  remotePid?: string;
  remotePath?: string;
};

async function runAndroidRecoveryAdb(
  deviceId: string,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await runAndroidAdb(androidDeviceForSerial(deviceId), args, options);
}

async function readAndroidRecoveryMetadata(deviceId: string): Promise<AndroidRecoveryManifestScan> {
  const scan: AndroidRecoveryManifestScan = { live: [], uncertain: [], blocked: [] };
  for (const metadataPath of androidRecoveryMetadataPaths()) {
    const result = await runAndroidRecoveryAdb(deviceId, ['shell', 'cat', metadataPath], {
      allowFailure: true,
      timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      continue;
    }
    const parsed = parseAndroidRecoveryManifest(result.stdout);
    if (parsed.kind === 'delete') {
      await cleanupAndroidRecoveryMetadataPath({
        deviceId,
        metadataPath,
        phase: 'record_stop_android_recovery_metadata_invalid_cleanup_failed',
      });
      continue;
    }
    if (parsed.kind === 'blocked') {
      scan.blocked.push({ metadataPath, reason: parsed.reason });
      continue;
    }
    const metadata = parsed.manifest;
    if (metadata.deviceId !== deviceId) {
      scan.blocked.push({ metadataPath, reason: 'device_mismatch' });
      continue;
    }
    const recovery = await resolveAndroidRecoveryCandidate(deviceId, metadata);
    if (recovery.kind === 'live') {
      scan.live.push(recovery.manifest);
      continue;
    }
    if (recovery.kind === 'uncertain') {
      scan.uncertain.push(metadata);
      continue;
    }
    await cleanupAndroidRecoveryMetadataPath({
      deviceId,
      metadataPath,
      phase: 'record_stop_android_recovery_metadata_stale_cleanup_failed',
    });
  }
  return scan;
}

async function resolveAndroidRecoveryCandidate(
  deviceId: string,
  manifest: AndroidRecordingRecoveryManifest,
): Promise<
  | { kind: 'live'; manifest: AndroidRecordingRecoveryCandidate }
  | { kind: 'stale' }
  | { kind: 'uncertain' }
> {
  if (manifest.status === 'pending') {
    return await resolvePendingAndroidRecoveryCandidate(deviceId, manifest);
  }
  if (manifest.status === 'rotating') {
    return await resolveRotatingAndroidRecoveryCandidate(deviceId, manifest);
  }
  if (!manifest.current) return { kind: 'stale' };
  const liveness = await checkRecoverableAndroidScreenrecord(deviceId, manifest.current);
  if (liveness === 'live') {
    return { kind: 'live', manifest: { ...manifest, current: manifest.current } };
  }
  if (liveness === 'finished') {
    return {
      kind: 'live',
      manifest: {
        ...manifest,
        current: manifest.current,
        recoveryWarning: ANDROID_RECOVERY_FINISHED_WARNING,
      },
    };
  }
  return { kind: liveness };
}

async function resolvePendingAndroidRecoveryCandidate(
  deviceId: string,
  manifest: AndroidRecordingRecoveryManifest,
): Promise<
  | { kind: 'live'; manifest: AndroidRecordingRecoveryCandidate }
  | { kind: 'stale' }
  | { kind: 'uncertain' }
> {
  if (!manifest.pending) return { kind: 'stale' };
  const pending = await findLiveAndroidScreenrecordByPath(deviceId, manifest.pending.remotePath);
  if (pending === 'uncertain') return { kind: 'uncertain' };
  if (!pending) return { kind: 'stale' };
  return {
    kind: 'live',
    manifest: {
      ...manifest,
      current: pending,
      recoveryWarning: ANDROID_RECOVERY_WARNING,
    },
  };
}

async function resolveRotatingAndroidRecoveryCandidate(
  deviceId: string,
  manifest: AndroidRecordingRecoveryManifest,
): Promise<
  | { kind: 'live'; manifest: AndroidRecordingRecoveryCandidate }
  | { kind: 'stale' }
  | { kind: 'uncertain' }
> {
  if (!manifest.pending || !manifest.current) return { kind: 'stale' };
  const pending = await findLiveAndroidScreenrecordByPath(deviceId, manifest.pending.remotePath);
  if (pending && pending !== 'uncertain') {
    return {
      kind: 'live',
      manifest: {
        ...manifest,
        current: pending,
        recoveryWarning: ANDROID_RECOVERY_ROTATION_WARNING,
      },
    };
  }

  const liveness = await checkRecoverableAndroidScreenrecord(deviceId, manifest.current);
  if (liveness === 'uncertain' || pending === 'uncertain') return { kind: 'uncertain' };
  if (liveness === 'stale') return { kind: 'stale' };
  return {
    kind: 'live',
    manifest: {
      ...manifest,
      current: manifest.current,
      chunks: chunksThroughRemotePath(manifest.chunks, manifest.current.remotePath),
      recoveryWarning:
        liveness === 'finished'
          ? `${ANDROID_RECOVERY_ROTATION_WARNING} ${ANDROID_RECOVERY_FINISHED_WARNING}`
          : ANDROID_RECOVERY_ROTATION_WARNING,
    },
  };
}

async function checkRecoverableAndroidScreenrecord(
  deviceId: string,
  metadata: AndroidRecordingRecoveryMetadata,
): Promise<'live' | 'stale' | 'uncertain' | 'finished'> {
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
  const pidLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(metadata.remotePid));
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
  if (pidLine?.includes('screenrecord')) return 'uncertain';
  if (pidLine) return 'stale';
  return (await androidRemoteFileExists(deviceId, metadata.remotePath)) ? 'finished' : 'stale';
}

async function findLiveAndroidScreenrecordByPath(
  deviceId: string,
  remotePath: string,
): Promise<AndroidRecordingRecoveryMetadata | 'uncertain' | undefined> {
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

async function androidRemoteFileExists(deviceId: string, remotePath: string): Promise<boolean> {
  const result = await runAndroidRecoveryAdb(deviceId, ['shell', 'stat', '-c', '%s', remotePath], {
    allowFailure: true,
    timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
  });
  const size = result.exitCode === 0 ? Number(result.stdout.trim()) : NaN;
  return Number.isFinite(size) && size >= ANDROID_RECOVERY_MANIFEST_STAT_SIZE_BYTES;
}

function chunksThroughRemotePath(
  chunks: AndroidRecordingRecoveryChunk[],
  remotePath: string,
): AndroidRecordingRecoveryChunk[] {
  const index = chunks.findIndex((chunk) => chunk.remotePath === remotePath);
  return index >= 0 ? chunks.slice(0, index + 1) : chunks;
}

export async function writeAndroidRecoveryPendingMetadata(params: {
  deviceId: string;
  activeSession: SessionState;
  recordingId: string;
  startedAt: number;
  showTouches: boolean;
  remotePath: string;
}): Promise<string | undefined> {
  const { deviceId, activeSession, recordingId, startedAt, showTouches, remotePath } = params;
  return await writeAndroidRecoveryManifest({
    deviceId,
    manifest: buildAndroidRecoveryPendingManifest({
      deviceId,
      activeSession,
      recordingId,
      startedAt,
      showTouches,
      remotePath,
    }),
    phase: 'record_start_android_recovery_metadata_failed',
  });
}

export async function writeAndroidRecoveryRotatingMetadata(params: {
  deviceId: string;
  activeSession: SessionState;
  recording: AndroidRecording;
  nextRemotePath: string;
  nextIndex: number;
}): Promise<string | undefined> {
  const { deviceId, activeSession, recording, nextRemotePath, nextIndex } = params;
  return await writeAndroidRecoveryManifest({
    deviceId,
    manifest: buildAndroidRecoveryRotatingManifest({
      deviceId,
      activeSession,
      recording,
      nextRemotePath,
      nextIndex,
    }),
    phase: 'record_rotate_android_recovery_metadata_failed',
  });
}

export async function writeAndroidRecoveryMetadata(params: {
  deviceId: string;
  activeSession: SessionState;
  recording: AndroidRecording;
}): Promise<string | undefined> {
  const { deviceId, activeSession, recording } = params;
  return await writeAndroidRecoveryManifest({
    deviceId,
    manifest: buildAndroidRecoveryManifest({ deviceId, activeSession, recording }),
    phase: 'record_start_android_recovery_metadata_failed',
  });
}

async function writeAndroidRecoveryManifest(params: {
  deviceId: string;
  manifest: AndroidRecordingRecoveryManifest;
  phase: string;
}): Promise<string | undefined> {
  const { deviceId, manifest, phase } = params;
  const currentPath = manifest.current?.remotePath ?? manifest.pending?.remotePath;
  if (!currentPath) return 'failed to write Android recording recovery manifest: missing path';
  const metadataPath = androidRecoveryMetadataPathForRemotePath(currentPath);
  const metadataTmpPath = `${metadataPath}.tmp`;
  const payload = JSON.stringify(manifest);
  const result = await runAndroidRecoveryAdb(
    deviceId,
    [
      'shell',
      `printf %s ${shellQuote(payload)} > ${shellQuote(metadataTmpPath)} && mv -f ${shellQuote(metadataTmpPath)} ${shellQuote(metadataPath)}`,
    ],
    {
      allowFailure: true,
      timeoutMs: ANDROID_RECOVERY_PROBE_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    emitAndroidRecoveryAdbFailure({
      phase,
      deviceId,
      metadataPath,
      result,
    });
    await cleanupAndroidRecoveryMetadataPath({
      deviceId,
      metadataPath: metadataTmpPath,
      phase: `${phase}_tmp_cleanup_failed`,
    });
    return `failed to write Android recording recovery manifest: ${formatRecordTraceExecFailure(result, 'adb shell write recovery manifest')}`;
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
  return undefined;
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
    emitAndroidRecoveryAdbFailure({
      phase,
      deviceId,
      metadataPath,
      result,
    });
  }
}

function emitAndroidRecoveryAdbFailure(params: {
  phase: string;
  deviceId: string;
  metadataPath: string;
  result: AndroidAdbExecutorResult;
}): void {
  const { phase, deviceId, metadataPath, result } = params;
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

export async function recoverMissingAndroidRecording(params: {
  activeSession: SessionState;
  device: AndroidDevice;
  recordingBase: AndroidRecordingBase;
}): Promise<DaemonResponse | AndroidRecording | null> {
  const { activeSession, device, recordingBase } = params;
  const manifests = await readAndroidRecoveryMetadata(device.id);
  if (manifests.live.length > 0) {
    return recoverAndroidRecordingFromManifest({
      activeSession,
      device,
      recordingBase,
      manifests: manifests.live,
    });
  }
  if (manifests.uncertain.length > 0) {
    return blockAndroidManifestRecoveryForUncertainManifest({
      activeSession,
      manifests: manifests.uncertain,
    });
  }
  if (manifests.blocked.length > 0) {
    return blockAndroidManifestRecoveryForBlockedManifest(manifests.blocked);
  }

  return null;
}

function blockAndroidManifestRecoveryForUncertainManifest(params: {
  activeSession: SessionState;
  manifests: AndroidRecordingRecoveryManifest[];
}): DaemonResponse {
  const { activeSession, manifests } = params;
  const matches = manifests.filter((manifest) =>
    androidRecoveryManifestMatchesSession(manifest, activeSession),
  );
  const activeRecordings = summarizeAndroidActiveRecordings(manifests);
  const details = {
    activeRecordings,
    recoveryBlocked: 'manifest_liveness_uncertain',
    hint: 'Retry record stop after the device responds. Android recording recovery requires a verified durable manifest.',
  };
  if (matches.length === 0) {
    return errorResponse('INVALID_ARGS', formatAndroidRecordingOwnerMismatch(manifests), details);
  }
  if (matches.length > 1 || manifests.length > 1) {
    return errorResponse(
      'INVALID_ARGS',
      'multiple active Android recording manifests could not be verified; cannot safely recover missing recording state',
      details,
    );
  }
  return errorResponse(
    'INVALID_ARGS',
    'active Android recording manifest could not be verified; retry record stop after the device responds',
    details,
  );
}

function blockAndroidManifestRecoveryForBlockedManifest(
  manifests: AndroidRecoveryBlockedManifest[],
): DaemonResponse {
  return errorResponse('INVALID_ARGS', 'active Android recording manifest could not be validated', {
    recoveryBlocked: 'manifest_invalid_or_unsupported',
    manifests,
    hint: 'Retry with the same agent-device version that started the recording, or inspect and remove stale device recovery metadata after confirming no recording is active.',
  });
}

function recoverAndroidRecordingFromManifest(params: {
  activeSession: SessionState;
  device: AndroidDevice;
  recordingBase: AndroidRecordingBase;
  manifests: AndroidRecordingRecoveryCandidate[];
}): DaemonResponse | AndroidRecording {
  const { activeSession, device, recordingBase, manifests } = params;
  const selected = selectAndroidRecoveryManifest({ activeSession, manifests });
  if ('ok' in selected) return selected;
  emitAndroidRecoveryDiagnostic(device, selected);
  return buildAndroidRecordingFromManifest(selected, recordingBase);
}

function selectAndroidRecoveryManifest(params: {
  activeSession: SessionState;
  manifests: AndroidRecordingRecoveryCandidate[];
}): DaemonResponse | AndroidRecordingRecoveryCandidate {
  const { activeSession, manifests } = params;
  const matches = manifests.filter((manifest) =>
    androidRecoveryManifestMatchesSession(manifest, activeSession),
  );
  const activeRecordings = summarizeAndroidActiveRecordings(manifests);
  if (matches.length === 0) {
    return errorResponse('INVALID_ARGS', formatAndroidRecordingOwnerMismatch(manifests), {
      activeRecordings,
    });
  }
  if (matches.length > 1 || manifests.length > 1) {
    return errorResponse(
      'INVALID_ARGS',
      'multiple active Android recording manifests exist; cannot safely recover missing recording state',
      { activeRecordings },
    );
  }
  return matches[0]!;
}

function summarizeAndroidActiveRecordings(
  manifests: AndroidRecordingRecoveryManifest[],
): AndroidActiveRecordingSummary[] {
  return manifests.map((manifest) => ({
    sessionName: manifest.sessionName,
    sessionScope: manifest.sessionScope,
    recordingId: manifest.recordingId,
    remotePid: manifest.current?.remotePid,
    remotePath: manifest.current?.remotePath ?? manifest.pending?.remotePath,
  }));
}

function emitAndroidRecoveryDiagnostic(
  device: AndroidDevice,
  manifest: AndroidRecordingRecoveryCandidate,
): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'record_stop_android_recovered_missing_state',
    data: {
      deviceId: device.id,
      sessionName: manifest.sessionName,
      recordingId: manifest.recordingId,
      remotePath: manifest.current.remotePath,
      remotePid: manifest.current.remotePid,
      chunks: manifest.chunks.length,
    },
  });
}

function buildAndroidRecordingFromManifest(
  manifest: AndroidRecordingRecoveryCandidate,
  recordingBase: AndroidRecordingBase,
): AndroidRecording {
  const recoveryWarning = manifest.recoveryWarning ?? ANDROID_RECOVERY_WARNING;
  return {
    platform: 'android',
    recordingId: manifest.recordingId,
    remotePath: manifest.current.remotePath,
    remotePid: manifest.current.remotePid,
    remoteStartedAt: manifest.current.startedAt,
    chunks: manifest.chunks.map((chunk) => ({
      index: chunk.index,
      path: deriveAndroidChunkOutPath(recordingBase.outPath, chunk.index),
      remotePath: chunk.remotePath,
    })),
    outPath: recordingBase.outPath,
    clientOutPath: recordingBase.clientOutPath,
    telemetryPath: recordingBase.telemetryPath,
    startedAt: manifest.startedAt,
    maxSize: recordingBase.maxSize,
    exportQuality: recordingBase.exportQuality,
    showTouches: false,
    gestureEvents: [],
    warning: manifest.showTouches
      ? `${recoveryWarning} ${ANDROID_RECOVERY_OVERLAY_WARNING}.`
      : recoveryWarning,
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
