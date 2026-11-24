import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { recordingExportFileIdentity } from '@agent-device/capture-kit/screen-recording-session-resource';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { TENANT_RESOURCE_REASONS } from '../core/tenant-owned-entry.ts';

export type RecordingSourceKind = 'original' | 'archive' | 'archive-replay';
export type RecordingFile = DaemonArtifact & { path: string; sourceIdentity?: string };
type VerifiedFile = RecordingFile & { sourceIdentity: string };
type Delivery = DaemonArtifact & { artifactId: string };

export type RecordingPublication = {
  timer: ReturnType<typeof setTimeout>;
  deliveries?: Delivery[];
  pending?: Promise<Delivery[]>;
};

type Registration = {
  delivery: Delivery;
  artifactPath: string;
  output: string;
};

function recordingOutputExpired(): AppError {
  return new AppError('COMMAND_FAILED', 'Recording output was consumed or expired.', {
    reason: TENANT_RESOURCE_REASONS.expired.reason,
  });
}

export async function publishRecordingFiles(params: {
  publications: Map<string, RecordingPublication>;
  producer: { lifetimeId: string; tenantId?: string; leaseVerifier: string | null };
  files: readonly RecordingFile[];
  expiresAt: number;
  sourceKind: RecordingSourceKind;
  isAvailable(id: string): boolean;
  register(files: Registration[], directory: string | undefined): void;
}): Promise<Delivery[]> {
  const { publications, producer, expiresAt, sourceKind } = params;
  const sourceOutsideArchive = sourceKind === 'original';
  // Legacy manifests have no export proof. Do not infer their identity from their path alone.
  const provenSources = params.files.filter(
    (file): file is VerifiedFile => file.sourceIdentity !== undefined,
  );
  const files = params.files.map((file) =>
    file.sourceIdentity === undefined
      ? { ...file, sourceIdentity: readSourceIdentity(file.path) }
      : { ...file, sourceIdentity: file.sourceIdentity },
  );
  const key = JSON.stringify([
    producer.lifetimeId,
    producer.tenantId,
    producer.leaseVerifier,
    files.map((file) => [file.path, file.sourceIdentity]),
  ]);
  let publication = publications.get(key);
  if (expiresAt <= Date.now()) throw recordingOutputExpired();
  if (publication?.deliveries) {
    if (publication.deliveries.every(({ artifactId }) => params.isAvailable(artifactId))) {
      return publication.deliveries;
    }
    throw recordingOutputExpired();
  }
  if (!publication) {
    // Archive staging is runtime-owned. A replay may use an existing publication, including a
    // retriable attempt, but surviving archive sources alone cannot restore consumed delivery.
    if (sourceKind === 'archive-replay') throw recordingOutputExpired();
    const timer = setTimeout(() => {
      const current = publications.get(key);
      publications.delete(key);
      if (!current?.deliveries && sourceOutsideArchive) expireUnregisteredSources(provenSources);
    }, expiresAt - Date.now()).unref();
    publication = { timer };
    publications.set(key, publication);
  }
  publication.pending ??= stageAndRegister(files, sourceOutsideArchive, (stored, directory) => {
    if (publications.get(key) !== publication || expiresAt <= Date.now()) {
      throw recordingOutputExpired();
    }
    params.register(stored, directory);
    return (publication.deliveries = stored.map(({ delivery }) => delivery));
  }).finally(() => {
    delete publication.pending;
  });
  return publication.pending;
}

function readSourceIdentity(sourcePath: string): string {
  const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!stat) throw recordingOutputExpired();
  return requireFileIdentity(stat);
}

function requireFileIdentity(stat: fs.Stats): string {
  const identity = recordingExportFileIdentity(stat);
  if (identity === null) throw changedRecordingOutput();
  return identity;
}

function changedRecordingOutput(): AppError {
  return new AppError('COMMAND_FAILED', 'Recording export is missing or has changed.');
}

async function stageAndRegister(
  files: readonly VerifiedFile[],
  sourceOutsideArchive: boolean,
  register: (files: Registration[], directory: string | undefined) => Delivery[],
): Promise<Delivery[]> {
  for (const file of files) {
    if (readSourceIdentity(file.path) !== file.sourceIdentity) throw changedRecordingOutput();
  }
  // The archive owns its original files. Only the independently downloadable files need staging.
  const directory = sourceOutsideArchive
    ? undefined
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-device-suite-recording-'));
  const staged: Registration[] = [];
  try {
    for (const { path: sourcePath, sourceIdentity, ...artifact } of files) {
      const delivery = { ...artifact, artifactId: crypto.randomUUID() };
      if (!directory) {
        staged.push({ delivery, artifactPath: sourcePath, output: sourceIdentity });
        continue;
      }
      const artifactPath = path.join(directory, delivery.artifactId);
      await fs.promises.copyFile(
        sourcePath,
        artifactPath,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
      );
      if (recordingExportFileIdentity(await fs.promises.lstat(sourcePath)) !== sourceIdentity) {
        throw changedRecordingOutput();
      }
      staged.push({
        delivery,
        artifactPath,
        output: requireFileIdentity(await fs.promises.lstat(artifactPath)),
      });
    }
    return register(staged, directory);
  } catch (error) {
    if (directory)
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function expireUnregisteredSources(files: readonly VerifiedFile[]): void {
  for (const { path: sourcePath, sourceIdentity } of files) {
    try {
      if (readSourceIdentity(sourcePath) === sourceIdentity) fs.unlinkSync(sourcePath);
    } catch {
      // A missing or inaccessible file cannot be cleaned up safely.
    }
  }
}
