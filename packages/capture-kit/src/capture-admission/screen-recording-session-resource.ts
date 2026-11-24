import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import { isRecord } from '@agent-device/kernel/record';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';
import type { RecordingAppIdentity } from '@agent-device/contracts/recording';
import type { StopObservation } from '@agent-device/contracts/recording-stop-observation';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DurableCaptureRecoveryControl,
  DurableCaptureSessionBinding,
} from '../durable-capture/index.ts';
import { withDurableCaptureResourceFence } from '../durable-capture/fence.ts';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { DurableCaptureFinishIntent } from './durable-capture-resource.ts';
import type { ScreenRecordingAdmissionLedger } from './screen-recording-admission-ledger.ts';
import {
  SCREEN_RECORDING_COMPLETION_METADATA_KEY,
  RecordingProofIoError,
  recordingCheckpointError,
  screenRecordingResourceStore,
} from './screen-recording-resource-store.ts';

export const screenRecordingDurableResource = createDurableCaptureResource<
  'screen-recording',
  ScreenRecordingLiveHandle,
  ScreenRecordingCompletion
>({
  resourceKind: 'screen-recording',
  displayName: 'screen recording',
  store: screenRecordingResourceStore,
  completionMetadata: async (result, metadata, progress) => ({
    ...encodeScreenRecordingCompletionMetadata(result),
    ...(typeof metadata?.remoteCapturePath === 'string' &&
    typeof metadata.remoteCaptureReservation === 'string'
      ? {
          remoteCaptureExport: await verifyRecordingExport(
            metadata.remoteCapturePath,
            result,
            metadata.remoteCaptureReservation,
            metadata,
            progress,
          ),
        }
      : {}),
  }),
  pendingCompletionMetadata: (result, error, completion) =>
    error instanceof RecordingProofIoError
      ? (completion ?? { ...encodeScreenRecordingCompletionMetadata(result), ...error.evidence })
      : undefined,
  nativeCleanupSettled: screenRecordingNativeCleanupSettled,
  // The manifest holds the whole stop response this kind wrote, so a caller that reaches the committed
  // record is served the same export the first stop was answered with. That answer is a cold path: the
  // record has to be read before anyone can be refused or served, so the reader is reached on demand
  // rather than added to what importing this kind evaluates.
  completionFromMetadata: async (metadata) =>
    (await import('./screen-recording-stop-recovery.ts')).readReplayableStoredCompletion(metadata),
  // ADR 0024 rule 6: the next stop re-collects the native artifact a failed export left behind, and
  // forced cleanup would delete exactly that. Disposal belongs to teardown and start rollback.
  failedFinishPolicy: 'preserve-retry-material',
  messages: {
    noActive: 'no active recording',
    cleanupPendingHint:
      'Keep screen-recording.resource.json and retry stop through its exact runtime owner.',
  },
});

export function screenRecordingNativeCleanupSettled(metadata: JsonObject | undefined): boolean {
  return (
    metadata?.phase === 'export-proof-pending' &&
    (metadata.cleanupStatus === 'cleaned' || metadata.cleanupStatus === 'already-missing')
  );
}

export function adoptStartedScreenRecording(params: {
  admissionLedger: ScreenRecordingAdmissionLedger;
  binding: DurableCaptureSessionBinding<'screen-recording', ScreenRecordingLiveHandle>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<ScreenRecordingLiveHandle>;
  envelope: DurableResourceEnvelope<'screen-recording'>;
  throwIfCanceled(): void;
}): Promise<void> {
  return screenRecordingDurableResource.adoptStarted(params);
}

export function finishLiveScreenRecording(params: {
  binding: DurableCaptureSessionBinding<'screen-recording', ScreenRecordingLiveHandle>;
  intent: DurableCaptureFinishIntent;
  confirmedMissing?: () => boolean;
}): Promise<ScreenRecordingCompletion> {
  return screenRecordingDurableResource.finishLive(params);
}

async function verifyRecordingExport(
  reservedPath: string,
  completion: ScreenRecordingCompletion,
  reservation: string,
  metadata: JsonObject,
  progress?: DurableCaptureProgress,
) {
  const [{ chunkPathAt }, { deriveRecordingTelemetryPath }] = await Promise.all([
    import('../recording/output-path.ts'),
    import('../recording/telemetry.ts'),
  ]);
  const files = [
    completion.outPath,
    ...(completion.chunks?.slice(1).map((chunk) => chunk.path) ?? []),
    ...(completion.telemetryPath ? [completion.telemetryPath] : []),
  ];
  const matchesReservation =
    completion.outPath === reservedPath &&
    (completion.chunks?.every(
      (chunk, offset) =>
        chunk.index === offset + 1 && chunk.path === chunkPathAt(reservedPath, chunk.index),
    ) ??
      true) &&
    (completion.telemetryPath === undefined ||
      completion.telemetryPath === deriveRecordingTelemetryPath(reservedPath));
  if (!matchesReservation) {
    throw new AppError('COMMAND_FAILED', 'Recording export does not match its reservation.');
  }
  const outputIds = files.map((_, index) => `${reservation}-${index + 1}`);
  const stored = metadata.remoteCaptureExport;
  if (stored !== undefined) {
    const { completedAt, known } = readRecordingExportProgress(stored, outputIds);
    if (known.some((identity, index) => readRecordingExportIdentity(files[index]!) !== identity)) {
      throw new AppError('COMMAND_FAILED', 'Recording export does not match its stored proof.');
    }
    if (known.length !== files.length) throw missingProducerProof();
    return { completedAt, identities: known, outputIds };
  }
  if (!progress) throw missingProducerProof();
  return checkpointRecordingExport(files, outputIds, progress);
}

function checkpointRecordingExport(
  files: readonly string[],
  outputIds: string[],
  progress: DurableCaptureProgress,
) {
  const completedAt = Date.now();
  const identities: string[] = [];
  const proof = { completedAt, identities, outputIds };
  const evidence = { remoteCaptureExport: proof };
  try {
    for (const file of files) identities.push(readRecordingExportIdentity(file));
    progress.record(evidence);
  } catch (error) {
    if (error instanceof RecordingProofIoError) throw new RecordingProofIoError(evidence);
    throw error;
  }
  return proof;
}

function readRecordingExportProgress(previous: unknown, outputIds: string[]) {
  const { completedAt, identities, outputIds: storedIds } = isRecord(previous) ? previous : {};
  if (
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt) ||
    !Array.isArray(identities) ||
    !identities.every((identity): identity is string => typeof identity === 'string') ||
    identities.length > outputIds.length ||
    !Array.isArray(storedIds) ||
    storedIds.length !== outputIds.length ||
    !outputIds.every((id, index) => id === storedIds[index])
  ) {
    throw new AppError('COMMAND_FAILED', 'Recording export does not match its stored proof.');
  }
  return { completedAt, known: identities };
}

function readRecordingExportIdentity(file: string): string {
  try {
    const identity = recordingExportFileIdentity(fs.lstatSync(file, { throwIfNoEntry: false }));
    if (identity !== null) return identity;
  } catch (error) {
    throw recordingCheckpointError(error);
  }
  throw new RecordingProofIoError();
}

function missingProducerProof(): AppError {
  return new AppError('COMMAND_FAILED', 'Recording export is missing producer proof.');
}

export async function finishPendingScreenRecordingProof(
  resourcePath: string,
  expected: DurableResourceEnvelope<'screen-recording'>,
): Promise<DurableResourceEnvelope<'screen-recording'>> {
  const { readStoredCompletion, unreadableRecordingProof } =
    await import('./screen-recording-stop-recovery.ts');
  return withDurableCaptureResourceFence({
    store: screenRecordingResourceStore,
    resourcePath,
    expected: expected.fence,
    onCompleted: ({ envelope }) => envelope,
    run: async (lease) => {
      const { metadata } = lease.envelope;
      const completion = readStoredCompletion(metadata);
      if (
        !metadata ||
        !screenRecordingNativeCleanupSettled(metadata) ||
        !completion ||
        typeof metadata.remoteCapturePath !== 'string' ||
        typeof metadata.remoteCaptureReservation !== 'string'
      )
        throw unreadableRecordingProof();
      const proof = await verifyRecordingExport(
        metadata.remoteCapturePath,
        completion,
        metadata.remoteCaptureReservation,
        metadata,
      );
      return lease.transition('completed', {
        metadata: {
          ...lease.envelope.metadata,
          phase: 'completed',
          remoteCaptureExport: proof,
        },
      });
    },
  });
}

export function recordingExportFileIdentity(stat: fs.Stats | undefined): string | null {
  return stat?.isFile()
    ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    : null;
}

export function encodeScreenRecordingCompletionMetadata(
  completion: ScreenRecordingCompletion,
): JsonObject {
  return {
    [SCREEN_RECORDING_COMPLETION_METADATA_KEY]: {
      backend: completion.backend,
      outPath: completion.outPath,
      startedAt: completion.startedAt,
      completedAt: completion.completedAt,
      ...(completion.capturedDurationMs === undefined
        ? {}
        : { capturedDurationMs: completion.capturedDurationMs }),
      ...(completion.stopObservation === undefined
        ? {}
        : { stopObservation: encodeStopObservation(completion.stopObservation) }),
      ...(completion.nativePathDisposition === undefined
        ? {}
        : { nativePathDisposition: completion.nativePathDisposition }),
      scope: completion.scope,
      showTouches: completion.showTouches,
      recordOnlySession: completion.recordOnlySession,
      ...(completion.clientOutPath === undefined
        ? {}
        : { clientOutPath: completion.clientOutPath }),
      ...(completion.telemetryPath === undefined
        ? {}
        : { telemetryPath: completion.telemetryPath }),
      ...(completion.warning === undefined ? {} : { warning: completion.warning }),
      ...(completion.overlayWarning === undefined
        ? {}
        : { overlayWarning: completion.overlayWarning }),
      ...(completion.activeSessionApp === undefined
        ? {}
        : { activeSessionApp: encodeAppIdentity(completion.activeSessionApp) }),
      ...(completion.chunks === undefined ? {} : { chunks: completion.chunks.map(encodeChunk) }),
    },
  };
}

function encodeAppIdentity(app: RecordingAppIdentity): JsonObject {
  return { bundleId: app.bundleId, ...(app.name === undefined ? {} : { name: app.name }) };
}

function encodeStopObservation(observation: StopObservation): JsonObject {
  return observation.recorder === 'confirmed'
    ? { recorder: observation.recorder }
    : { recorder: observation.recorder, why: observation.why };
}

function encodeChunk(chunk: ScreenRecordingChunk): JsonObject {
  return {
    index: chunk.index,
    path: chunk.path,
    ...(chunk.clientOutPath === undefined ? {} : { clientOutPath: chunk.clientOutPath }),
  };
}

export function finishRecoveredScreenRecording(params: {
  resourcePath: string;
  scope: PlatformRequestScope;
  acquireControl(
    envelope: DurableResourceEnvelope<'screen-recording'>,
    scope: PlatformRequestScope,
  ): Promise<
    DurableCaptureRecoveryControl<
      'screen-recording',
      ScreenRecordingLiveHandle,
      ScreenRecordingCompletion
    >
  >;
  deadlineMs?: number;
}): Promise<ScreenRecordingCompletion> {
  return screenRecordingDurableResource.finishRecovered(params);
}
