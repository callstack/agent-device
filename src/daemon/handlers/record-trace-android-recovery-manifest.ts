import path from 'node:path';
import type { RecordingChunk, SessionState } from '../types.ts';

const ANDROID_RECOVERY_METADATA_FILE = 'agent-device-recording-active.json';
const ANDROID_RECOVERY_METADATA_DIRS = ['/sdcard', '/data/local/tmp'] as const;
const ANDROID_RECOVERY_MANIFEST_VERSION = 1;

type AndroidRecording = Extract<NonNullable<SessionState['recording']>, { platform: 'android' }>;

export type AndroidRecordingRecoveryMetadata = {
  remotePath: string;
  remotePid: string;
  startedAt: number;
};

type AndroidRecordingRecoveryPending = {
  remotePath: string;
};

type AndroidRecordingRecoveryManifestStatus = 'pending' | 'live' | 'rotating';

export type AndroidRecordingRecoveryManifest = {
  version: 1;
  status: AndroidRecordingRecoveryManifestStatus;
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  recordingId: string;
  deviceId: string;
  startedAt: number;
  showTouches: boolean;
  current?: AndroidRecordingRecoveryMetadata;
  pending?: AndroidRecordingRecoveryPending;
  chunks: AndroidRecordingRecoveryChunk[];
};

export type AndroidRecordingRecoveryChunk = Pick<RecordingChunk, 'index' | 'remotePath'>;

type AndroidRecordingRecoveryManifestRequired = Pick<
  AndroidRecordingRecoveryManifest,
  'version' | 'sessionName' | 'recordingId' | 'deviceId' | 'startedAt' | 'showTouches'
>;

export function parseRecoverableAndroidScreenrecord(
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

export function parseAndroidRecoveryManifest(
  value: string,
):
  | { kind: 'manifest'; manifest: AndroidRecordingRecoveryManifest }
  | { kind: 'delete' }
  | { kind: 'blocked'; reason: string } {
  const metadata = parseJsonObject(value);
  if (!metadata) return { kind: 'delete' };
  const required = readAndroidRecoveryManifestRequired(metadata);
  if (!required) return { kind: 'blocked', reason: 'unsupported_or_malformed_manifest' };
  const parsedCurrent = parseAndroidRecoveryMetadata(metadata.current);
  const parsedPending = parseAndroidRecoveryPending(metadata.pending);
  const chunks = parseAndroidRecordingChunks(metadata.chunks);
  if (!chunks) return { kind: 'blocked', reason: 'invalid_recording_chunks' };
  const status = readAndroidRecoveryManifestStatus(metadata.status, {
    hasCurrent: parsedCurrent !== undefined,
    hasPending: parsedPending !== undefined,
  });
  if (!status) return { kind: 'blocked', reason: 'invalid_recording_status' };
  if (status === 'live' && !parsedCurrent) {
    return { kind: 'blocked', reason: 'invalid_current_recording' };
  }
  if (status === 'pending' && !parsedPending) {
    return { kind: 'blocked', reason: 'invalid_pending_recording' };
  }
  if (status === 'rotating' && (!parsedCurrent || !parsedPending)) {
    return { kind: 'blocked', reason: 'invalid_rotating_recording' };
  }
  return {
    kind: 'manifest',
    manifest: {
      ...required,
      status,
      sessionScope: parseSessionScope(metadata.sessionScope),
      current: parsedCurrent,
      pending: parsedPending,
      chunks,
    },
  };
}

export function androidRecoveryMetadataPathForRemotePath(remotePath: string): string {
  return `${path.posix.dirname(remotePath)}/${ANDROID_RECOVERY_METADATA_FILE}`;
}

export function androidRecoveryMetadataPaths(): string[] {
  return ANDROID_RECOVERY_METADATA_DIRS.map((dir) => `${dir}/${ANDROID_RECOVERY_METADATA_FILE}`);
}

export function buildAndroidRecoveryPendingManifest(params: {
  deviceId: string;
  activeSession: SessionState;
  recordingId: string;
  startedAt: number;
  showTouches: boolean;
  remotePath: string;
}): AndroidRecordingRecoveryManifest {
  const { deviceId, activeSession, recordingId, startedAt, showTouches, remotePath } = params;
  return {
    version: ANDROID_RECOVERY_MANIFEST_VERSION,
    status: 'pending',
    sessionName: activeSession.name,
    sessionScope: activeSession.sessionScope,
    recordingId,
    deviceId,
    startedAt,
    showTouches,
    pending: { remotePath },
    chunks: [{ index: 1, remotePath }],
  };
}

export function buildAndroidRecoveryManifest(params: {
  deviceId: string;
  activeSession: SessionState;
  recording: AndroidRecording;
}): AndroidRecordingRecoveryManifest {
  const { deviceId, activeSession, recording } = params;
  return {
    version: ANDROID_RECOVERY_MANIFEST_VERSION,
    status: 'live',
    sessionName: activeSession.name,
    sessionScope: activeSession.sessionScope,
    recordingId:
      recording.recordingId ??
      `android-${recording.remotePid}-${recording.remoteStartedAt ?? recording.startedAt}`,
    deviceId,
    startedAt: recording.startedAt,
    showTouches: recording.showTouches,
    current: {
      remotePath: recording.remotePath,
      remotePid: recording.remotePid,
      startedAt: recording.remoteStartedAt ?? recording.startedAt,
    },
    chunks: (recording.chunks ?? [{ index: 1, remotePath: recording.remotePath }]).map((chunk) => ({
      index: chunk.index,
      remotePath: chunk.remotePath,
    })),
  };
}

export function buildAndroidRecoveryRotatingManifest(params: {
  deviceId: string;
  activeSession: SessionState;
  recording: AndroidRecording;
  nextRemotePath: string;
  nextIndex: number;
}): AndroidRecordingRecoveryManifest {
  const { deviceId, activeSession, recording, nextRemotePath, nextIndex } = params;
  const chunks = [
    ...(recording.chunks ?? [{ index: 1, remotePath: recording.remotePath }]),
    { index: nextIndex, remotePath: nextRemotePath },
  ].map((chunk) => ({ index: chunk.index, remotePath: chunk.remotePath }));
  return {
    ...buildAndroidRecoveryManifest({ deviceId, activeSession, recording }),
    status: 'rotating',
    pending: { remotePath: nextRemotePath },
    chunks,
  };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readAndroidRecoveryManifestRequired(
  metadata: Record<string, unknown>,
): AndroidRecordingRecoveryManifestRequired | undefined {
  if (metadata.version !== ANDROID_RECOVERY_MANIFEST_VERSION) return undefined;
  const strings = readAndroidRecoveryManifestStrings(metadata);
  if (!strings) return undefined;
  const startedAt = readOptionalNumber(metadata.startedAt);
  if (startedAt === undefined) return undefined;
  const showTouches = readOptionalBoolean(metadata.showTouches);
  if (showTouches === undefined) return undefined;
  return {
    version: ANDROID_RECOVERY_MANIFEST_VERSION,
    ...strings,
    startedAt,
    showTouches,
  };
}

function readAndroidRecoveryManifestStrings(
  metadata: Record<string, unknown>,
):
  | Pick<AndroidRecordingRecoveryManifestRequired, 'sessionName' | 'recordingId' | 'deviceId'>
  | undefined {
  const sessionName = readOptionalString(metadata.sessionName);
  const recordingId = readOptionalString(metadata.recordingId);
  const deviceId = readOptionalString(metadata.deviceId);
  if (!sessionName || !recordingId || !deviceId) return undefined;
  return { sessionName, recordingId, deviceId };
}

function readAndroidRecoveryManifestStatus(
  value: unknown,
  metadata: { hasCurrent: boolean; hasPending: boolean },
): AndroidRecordingRecoveryManifestStatus | undefined {
  if (value === undefined && metadata.hasCurrent) return 'live';
  if (value === 'pending' || value === 'live' || value === 'rotating') return value;
  return undefined;
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

function parseAndroidRecoveryPending(value: unknown): AndroidRecordingRecoveryPending | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const metadata = value as Partial<AndroidRecordingRecoveryPending>;
  if (
    typeof metadata.remotePath !== 'string' ||
    !isAndroidAgentRecordingPath(metadata.remotePath)
  ) {
    return undefined;
  }
  return { remotePath: metadata.remotePath };
}

function parseAndroidRecordingChunks(value: unknown): AndroidRecordingRecoveryChunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value
    .map(parseAndroidRecordingChunk)
    .filter((chunk): chunk is AndroidRecordingRecoveryChunk => chunk !== undefined);
  return chunks.length > 0 && chunks.length === value.length ? chunks : undefined;
}

function parseAndroidRecordingChunk(value: unknown): AndroidRecordingRecoveryChunk | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const chunk = value as Partial<RecordingChunk>;
  if (
    typeof chunk.index !== 'number' ||
    !Number.isInteger(chunk.index) ||
    chunk.index < 1 ||
    typeof chunk.remotePath !== 'string' ||
    !isAndroidAgentRecordingPath(chunk.remotePath)
  ) {
    return undefined;
  }
  return {
    index: chunk.index,
    remotePath: chunk.remotePath,
  };
}

function parseSessionScope(value: unknown): SessionState['sessionScope'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const scope = value as Partial<NonNullable<SessionState['sessionScope']>>;
  if (scope.kind !== 'cwd' || typeof scope.id !== 'string') return undefined;
  return { kind: 'cwd', id: scope.id };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isAndroidAgentRecordingPath(remotePath: string): boolean {
  return /^\/(?:sdcard|data\/local\/tmp)\/agent-device-recording-\d+\.mp4$/.test(remotePath);
}
