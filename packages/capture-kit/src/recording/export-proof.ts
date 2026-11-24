import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import {
  RecordingProofIoError,
  SCREEN_RECORDING_COMPLETION_METADATA_KEY,
  recordingCheckpointError,
  recordingExportFileIdentity,
} from '../capture-admission/screen-recording-resource-store.ts';
import { chunkPathAt } from './output-path.ts';
import { readStopCheckpoints } from './stop-checkpoints.ts';
import { deriveRecordingTelemetryPath } from './telemetry.ts';

export function verifyRecordingExport(
  reservedPath: string,
  completion: ScreenRecordingCompletion,
  metadata: JsonObject,
  progress?: DurableCaptureProgress,
) {
  const files = recordingExportFiles(reservedPath, completion);
  const stored = metadata.remoteCaptureExport;
  if (stored !== undefined) {
    const { completedAt, identities } = readRecordingExportProgress(stored, files.length);
    if (
      identities.some(
        (identity, index) =>
          identity !== null && readRecordingExportIdentity(files[index]!) !== identity,
      )
    ) {
      throw new AppError('COMMAND_FAILED', 'Recording export does not match its stored proof.');
    }
    if (identities.includes(null)) {
      if (progress && metadata[SCREEN_RECORDING_COMPLETION_METADATA_KEY] === undefined)
        throw new RecordingProofIoError({ remoteCaptureExport: { completedAt, identities } });
      throw missingProducerProof();
    }
    return { completedAt, identities };
  }
  if (!progress || readStopCheckpoints(metadata).finalization) throw missingProducerProof();
  const evidence = captureRecordingExportEvidence(reservedPath, completion);
  if (evidence.remoteCaptureExport.identities.includes(null))
    throw new RecordingProofIoError(evidence);
  try {
    progress.record(evidence);
  } catch (error) {
    if (error instanceof RecordingProofIoError) throw new RecordingProofIoError(evidence);
    throw error;
  }
  return evidence.remoteCaptureExport;
}

/** Capture the identities while the producer still controls the finalized files. */
export function captureRecordingExportEvidence(
  reservedPath: string,
  completion: ScreenRecordingCompletion,
) {
  const files = recordingExportFiles(reservedPath, completion);
  const completedAt = Date.now();
  const identities: (string | null)[] = files.map(() => null);
  try {
    for (const [index, file] of files.entries())
      identities[index] = readRecordingExportIdentity(file);
  } catch (error) {
    if (!(error instanceof RecordingProofIoError)) throw error;
  }
  return { remoteCaptureExport: { completedAt, identities } };
}

function recordingExportFiles(reservedPath: string, completion: ScreenRecordingCompletion) {
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
  return files;
}

function readRecordingExportProgress(previous: unknown, fileCount: number) {
  const { completedAt, identities } = isRecord(previous) ? previous : {};
  if (
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt) ||
    !Array.isArray(identities) ||
    identities.length !== fileCount ||
    !identities.every(
      (identity): identity is string | null => identity === null || typeof identity === 'string',
    )
  ) {
    throw new AppError('COMMAND_FAILED', 'Recording export does not match its stored proof.');
  }
  return { completedAt, identities };
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
