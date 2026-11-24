import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { recordingExportFileIdentity } from '@agent-device/capture-kit/screen-recording-session-resource';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { TENANT_RESOURCE_REASONS } from '../core/tenant-owned-entry.ts';

export type RecordingSource = { sourcePath: string; sourceIdentity: string };

export function recordingOutputExpired(): AppError {
  return new AppError('COMMAND_FAILED', 'Recording output was consumed or expired.', {
    reason: TENANT_RESOURCE_REASONS.expired.reason,
  });
}

function reserveRecordingCopyDirectory(sourceOutsideArchive: boolean, pendingCount: number) {
  return sourceOutsideArchive || pendingCount === 0
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-suite-recording-'));
}

function stageRecordingFiles(
  pending: readonly { artifactId: string; recording: RecordingSource }[],
  directory: string | undefined,
) {
  try {
    return pending.map(({ artifactId, recording: { sourcePath, sourceIdentity } }) => {
      if (!directory) return { artifactPath: sourcePath, output: sourceIdentity };
      const artifactPath = path.join(directory, artifactId);
      fs.copyFileSync(
        sourcePath,
        artifactPath,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
      );
      if (recordingExportFileIdentity(fs.lstatSync(sourcePath)) !== sourceIdentity) {
        throw new AppError('COMMAND_FAILED', 'Recording export changed while preparing delivery.');
      }
      return { artifactPath, output: recordingExportFileIdentity(fs.lstatSync(artifactPath))! };
    });
  } catch (error) {
    if (directory) removeBestEffort(directory);
    throw error;
  }
}

/** Drops only proven files and only once the producer's retention window has ended. */
export function expireUnregisteredRecordingFiles(
  sources: readonly RecordingSource[],
  expiresAt: number,
): void {
  const expire = () => {
    for (const { sourcePath, sourceIdentity } of sources) {
      try {
        const stat = fs.lstatSync(sourcePath);
        if (stat.isFile() && recordingExportFileIdentity(stat) === sourceIdentity)
          fs.unlinkSync(sourcePath);
      } catch {
        // A missing file has already been consumed or removed by the registry.
      }
    }
  };
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) expire();
  else setTimeout(expire, remaining).unref();
}

export function prepareRecordingDelivery(
  files: readonly (DaemonArtifact & { path: string; stat: fs.Stats })[],
  findExisting: (source: RecordingSource) => string | undefined,
  sourceOutsideArchive: boolean,
) {
  const pending = [];
  const deliveries = [];
  for (const { path: sourcePath, stat, ...delivery } of files) {
    const sourceIdentity = recordingExportFileIdentity(stat);
    if (sourceIdentity === null) throw recordingOutputExpired();
    const recording = { sourcePath, sourceIdentity };
    const existing = findExisting(recording);
    const artifactId = existing ?? crypto.randomUUID();
    deliveries.push({ ...delivery, artifactId });
    if (!existing) pending.push({ artifactId, delivery, recording });
  }
  // An archive download consumes its directory. Only the independently retained recording
  // files get a separate copy, with the same producer and expiration.
  const directory = reserveRecordingCopyDirectory(sourceOutsideArchive, pending.length);
  const stored = stageRecordingFiles(pending, directory);
  return {
    directory,
    deliveries,
    registrations: pending.map((entry, index) => ({ ...entry, ...stored[index]! })),
  };
}

function removeBestEffort(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}
