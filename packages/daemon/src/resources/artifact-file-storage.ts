import fs from 'node:fs';
import { publishDurableFileSync } from '@agent-device/host-kit/file';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { recordingExportFileIdentity } from '@agent-device/capture-kit/screen-recording-session-resource';
import { AppError } from '@agent-device/kernel/errors';
import { TENANT_RESOURCE_REASONS } from '../core/tenant-owned-entry.ts';

export type RecordingFile = DaemonArtifact & {
  path: string;
  sourceIdentity: string;
  artifactId: string;
};

function expiredRecording(): AppError {
  return new AppError('COMMAND_FAILED', 'Recording output was consumed or expired.', {
    reason: TENANT_RESOURCE_REASONS.expired.reason,
  });
}

export function verifyRecordingFiles(files: readonly RecordingFile[], expiresAt: number): void {
  if (Date.now() >= expiresAt) throw expiredRecording();
  for (const file of files) {
    if (inspectRecordingPath(consumptionPath(file.path))) {
      throw expiredRecording();
    }
    const stat = inspectRecordingPath(file.path);
    if (!stat) throw expiredRecording();
    if (recordingExportFileIdentity(stat) !== file.sourceIdentity) {
      throw new AppError('COMMAND_FAILED', 'Recording export is missing or has changed.');
    }
  }
}

function inspectRecordingPath(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Recording output could not be inspected.',
      { retriable: true },
      error,
    );
  }
}

export function retainUnregisteredRecording(
  pending: Map<string, ReturnType<typeof setTimeout>>,
  reservationId: string,
  files: readonly RecordingFile[],
  expiresAt: number,
): void {
  if (files.length === 0 || pending.has(reservationId)) return;
  const expire = () => {
    pending.delete(reservationId);
    expireUnregisteredSources(files);
  };
  if (expiresAt <= Date.now()) expire();
  else pending.set(reservationId, setTimeout(expire, expiresAt - Date.now()).unref());
}

export function recordConsumption(file: string, expiresAt: number): void {
  const receipt = consumptionPath(file);
  publishDurableFileSync({ destination: receipt, contents: 'consumed\n' });
  setTimeout(
    () => {
      try {
        fs.unlinkSync(receipt);
      } catch {
        // A receipt survives if the directory is inaccessible.
      }
    },
    Math.max(0, expiresAt - Date.now()),
  ).unref();
}

function consumptionPath(file: string): string {
  return file + '.consumed';
}

function expireUnregisteredSources(files: readonly RecordingFile[]): void {
  for (const { path, sourceIdentity } of files) {
    try {
      if (
        recordingExportFileIdentity(fs.lstatSync(path, { throwIfNoEntry: false })) ===
        sourceIdentity
      ) {
        fs.unlinkSync(path);
      }
    } catch {
      // Keep files whose identity cannot be established.
    }
  }
}
