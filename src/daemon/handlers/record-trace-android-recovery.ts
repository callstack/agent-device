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
type AndroidRecoveryResolution =
  | { kind: 'live'; manifest: AndroidRecordingRecoveryCandidate }
  | { kind: 'stale' }
  | { kind: 'uncertain' };
type AndroidScreenrecordProbe = AndroidRecordingRecoveryMetadata | 'uncertain' | undefined;

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

type AndroidOwnedManifestSelection<T extends AndroidRecordingRecoveryManifest> =
  | {
      kind: 'selected';
      manifest: T;
      activeRecordings: AndroidActiveRecordingSummary[];
    }
  | { kind: 'owner-mismatch'; activeRecordings: AndroidActiveRecordingSummary[] }
  | { kind: 'ambiguous'; activeRecordings: AndroidActiveRecordingSummary[] };

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
): Promise<AndroidRecoveryResolution> {
  if (manifest.pending) {
    return await resolvePendingAndroidRecoveryCandidate(deviceId, manifest, manifest.pending);
  }
  return await resolveCurrentAndroidRecoveryCandidate(deviceId, manifest);
}

async function resolvePendingAndroidRecoveryCandidate(
  deviceId: string,
  manifest: AndroidRecordingRecoveryManifest,
  pendingMetadata: { remotePath: string },
): Promise<AndroidRecoveryResolution> {
  const pending = await findLiveAndroidScreenrecordByPath(deviceId, pendingMetadata.remotePath);
  const adoptedPending = resolveLivePendingScreenrecord(manifest, pending);
  if (adoptedPending) return adoptedPending;
  if (!manifest.current) {
    return await resolvePendingOnlyAndroidRecoveryCandidate(
      deviceId,
      manifest,
      pendingMetadata.remotePath,
      pending,
    );
  }
  return await resolveInterruptedRotationCurrent(deviceId, manifest, manifest.current, pending);
}

async function resolveInterruptedRotationCurrent(
  deviceId: string,
  manifest: AndroidRecordingRecoveryManifest,
  current: AndroidRecordingRecoveryMetadata,
  pending: AndroidScreenrecordProbe,
): Promise<AndroidRecoveryResolution> {
  const liveness = await checkRecoverableAndroidScreenrecord(deviceId, current);
  if (liveness === 'uncertain' || pending === 'uncertain') return { kind: 'uncertain' };
  if (liveness === 'stale') return { kind: 'stale' };
  return liveAndroidRecoveryCandidate({
    manifest,
    current,
    chunks: chunksThroughRemotePath(manifest.chunks, current.remotePath),
    recoveryWarning:
      liveness === 'finished'
        ? `${ANDROID_RECOVERY_ROTATION_WARNING} ${ANDROID_RECOVERY_FINISHED_WARNING}`
        : ANDROID_RECOVERY_ROTATION_WARNING,
  });
}

function resolveLivePendingScreenrecord(
  manifest: AndroidRecordingRecoveryManifest,
  pending: AndroidScreenrecordProbe,
): AndroidRecoveryResolution | undefined {
  if (!pending || pending === 'uncertain') return undefined;
  return liveAndroidRecoveryCandidate({
    manifest,
    current: pending,
    recoveryWarning: manifest.current
      ? ANDROID_RECOVERY_ROTATION_WARNING
      : ANDROID_RECOVERY_WARNING,
  });
}

async function resolvePendingOnlyAndroidRecoveryCandidate(
  deviceId: string,
  manifest: AndroidRecordingRecoveryManifest,
  pendingRemotePath: string,
  pending: AndroidScreenrecordProbe,
): Promise<AndroidRecoveryResolution> {
  if (pending === 'uncertain') {
    return { kind: 'uncertain' };
  }
  // The pending screenrecord process is gone. If it already produced an on-device file,
  // recover it as a finished recording rather than discarding a completed capture — the
  // same treatment resolveCurrentAndroidRecoveryCandidate gives a finished `current`.
  if (await androidRemoteFileExists(deviceId, pendingRemotePath)) {
    return liveAndroidRecoveryCandidate({
      manifest,
      current: {
        remotePath: pendingRemotePath,
        // A pending chunk never recorded a pid — the manifest is written before the
        // screenrecord process starts. The process is confirmed gone, so there is
        // nothing to signal; the empty pid tells finishCurrentAndroidRecordingChunk to
        // skip the stop signal.
        remotePid: '',
        startedAt: manifest.startedAt,
      },
      recoveryWarning: ANDROID_RECOVERY_FINISHED_WARNING,
    });
  }
  return { kind: 'stale' };
}

async function resolveCurrentAndroidRecoveryCandidate(
  deviceId: string,
  manifest: AndroidRecordingRecoveryManifest,
): Promise<AndroidRecoveryResolution> {
  if (!manifest.current) return { kind: 'stale' };
  const liveness = await checkRecoverableAndroidScreenrecord(deviceId, manifest.current);
  if (liveness === 'live') {
    return liveAndroidRecoveryCandidate({ manifest, current: manifest.current });
  }
  if (liveness === 'finished') {
    return liveAndroidRecoveryCandidate({
      manifest,
      current: manifest.current,
      recoveryWarning: ANDROID_RECOVERY_FINISHED_WARNING,
    });
  }
  return { kind: liveness };
}

function liveAndroidRecoveryCandidate(params: {
  manifest: AndroidRecordingRecoveryManifest;
  current: AndroidRecordingRecoveryMetadata;
  chunks?: AndroidRecordingRecoveryChunk[];
  recoveryWarning?: string;
}): { kind: 'live'; manifest: AndroidRecordingRecoveryCandidate } {
  const { manifest, current, chunks, recoveryWarning } = params;
  return {
    kind: 'live',
    manifest: {
      ...manifest,
      current,
      chunks: chunks ?? manifest.chunks,
      ...(recoveryWarning ? { recoveryWarning } : {}),
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
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  recordingId: string;
  startedAt: number;
  showTouches: boolean;
  remotePath: string;
}): Promise<string | undefined> {
  const { deviceId, sessionName, sessionScope, recordingId, startedAt, showTouches, remotePath } =
    params;
  return await writeAndroidRecoveryManifest({
    deviceId,
    manifest: buildAndroidRecoveryPendingManifest({
      deviceId,
      sessionName,
      sessionScope,
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
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  recording: AndroidRecording;
  nextRemotePath: string;
  nextIndex: number;
}): Promise<string | undefined> {
  const { deviceId, sessionName, sessionScope, recording, nextRemotePath, nextIndex } = params;
  return await writeAndroidRecoveryManifest({
    deviceId,
    manifest: buildAndroidRecoveryRotatingManifest({
      deviceId,
      sessionName,
      sessionScope,
      recording,
      nextRemotePath,
      nextIndex,
    }),
    phase: 'record_rotate_android_recovery_metadata_failed',
  });
}

export async function writeAndroidRecoveryMetadata(params: {
  deviceId: string;
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  recording: AndroidRecording;
}): Promise<string | undefined> {
  const { deviceId, sessionName, sessionScope, recording } = params;
  return await writeAndroidRecoveryManifest({
    deviceId,
    manifest: buildAndroidRecoveryManifest({ deviceId, sessionName, sessionScope, recording }),
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
  sessionName: string;
  activeSession: SessionState;
  device: AndroidDevice;
  recordingBase: AndroidRecordingBase;
}): Promise<DaemonResponse | AndroidRecording | null> {
  const { sessionName, activeSession, device, recordingBase } = params;
  const manifests = await readAndroidRecoveryMetadata(device.id);
  if (manifests.live.length > 0) {
    return recoverAndroidRecordingFromManifest({
      sessionName,
      activeSession,
      device,
      recordingBase,
      manifests: manifests.live,
    });
  }
  if (manifests.uncertain.length > 0) {
    return blockAndroidManifestRecoveryForUncertainManifest({
      sessionName,
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
  sessionName: string;
  activeSession: SessionState;
  manifests: AndroidRecordingRecoveryManifest[];
}): DaemonResponse {
  const { sessionName, activeSession, manifests } = params;
  const selection = selectOwnedAndroidRecoveryManifest({ sessionName, activeSession, manifests });
  const details = {
    activeRecordings: selection.activeRecordings,
    recoveryBlocked: 'manifest_liveness_uncertain',
    hint: 'Retry record stop after the device responds. Android recording recovery requires a verified durable manifest.',
  };
  if (selection.kind === 'owner-mismatch') {
    return errorResponse('INVALID_ARGS', formatAndroidRecordingOwnerMismatch(manifests), details);
  }
  if (selection.kind === 'ambiguous') {
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
  sessionName: string;
  activeSession: SessionState;
  device: AndroidDevice;
  recordingBase: AndroidRecordingBase;
  manifests: AndroidRecordingRecoveryCandidate[];
}): DaemonResponse | AndroidRecording {
  const { sessionName, activeSession, device, recordingBase, manifests } = params;
  const selected = selectAndroidRecoveryManifest({ sessionName, activeSession, manifests });
  if ('ok' in selected) return selected;
  emitAndroidRecoveryDiagnostic(device, selected);
  return buildAndroidRecordingFromManifest(selected, recordingBase);
}

function selectAndroidRecoveryManifest(params: {
  sessionName: string;
  activeSession: SessionState;
  manifests: AndroidRecordingRecoveryCandidate[];
}): DaemonResponse | AndroidRecordingRecoveryCandidate {
  const { sessionName, activeSession, manifests } = params;
  const selection = selectOwnedAndroidRecoveryManifest({ sessionName, activeSession, manifests });
  if (selection.kind === 'selected') return selection.manifest;
  if (selection.kind === 'owner-mismatch') {
    return errorResponse('INVALID_ARGS', formatAndroidRecordingOwnerMismatch(manifests), {
      activeRecordings: selection.activeRecordings,
    });
  }
  return errorResponse(
    'INVALID_ARGS',
    'multiple active Android recording manifests exist; cannot safely recover missing recording state',
    { activeRecordings: selection.activeRecordings },
  );
}

function selectOwnedAndroidRecoveryManifest<T extends AndroidRecordingRecoveryManifest>(params: {
  sessionName: string;
  activeSession: SessionState;
  manifests: T[];
}): AndroidOwnedManifestSelection<T> {
  const { sessionName, activeSession, manifests } = params;
  const matches = manifests.filter((manifest) =>
    androidRecoveryManifestMatchesSession(manifest, sessionName, activeSession),
  );
  const activeRecordings = summarizeAndroidActiveRecordings(manifests);
  if (matches.length === 0) {
    return { kind: 'owner-mismatch', activeRecordings };
  }
  if (matches.length > 1 || manifests.length > 1) {
    return { kind: 'ambiguous', activeRecordings };
  }
  return { kind: 'selected', manifest: matches[0]!, activeRecordings };
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
  sessionName: string,
  activeSession: SessionState,
): boolean {
  return (
    manifest.sessionName === sessionName &&
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
    const manifest = manifests[0]!;
    if (manifest.sessionScope) {
      return `active Android recording belongs to session "${manifest.sessionName}" in ${manifest.sessionScope.kind} scope; retry record stop from the original working directory without --session to recover it`;
    }
    return `active Android recording belongs to session "${manifest.sessionName}"; run record stop --session ${manifest.sessionName} to recover it`;
  }
  return 'active Android recordings belong to other sessions; cannot safely recover missing recording state';
}
