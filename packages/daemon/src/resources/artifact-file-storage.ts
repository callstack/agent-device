import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { recordingExportFileIdentity } from '@agent-device/capture-kit/screen-recording-session-resource';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { settleWithin } from '@agent-device/host-kit/settle-within';
import { TENANT_RESOURCE_REASONS } from '../core/tenant-owned-entry.ts';

export type RecordingSourceKind = 'original' | 'archive' | 'archive-replay';
export type RecordingFile = DaemonArtifact & { path: string; sourceIdentity?: string };
type VerifiedFile = RecordingFile & { sourceIdentity: string };
type Delivery = DaemonArtifact & { artifactId: string };

export type RecordingPublication = {
  signal: AbortSignal;
  dispose(): void;
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
  if (expiresAt <= Date.now()) {
    if (!publication && sourceOutsideArchive) expireUnregisteredSources(provenSources);
    throw recordingOutputExpired();
  }
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
    publication = createRecordingPublication(
      expiresAt,
      () => publications.delete(key),
      sourceOutsideArchive ? provenSources : [],
    );
    publications.set(key, publication);
  }
  const assertActive = () => {
    publication.signal.throwIfAborted();
    if (expiresAt <= Date.now()) throw recordingOutputExpired();
  };
  publication.pending ??= waitForRecordingPublication(
    publication.signal,
    expiresAt,
    stageAndRegister(files, sourceOutsideArchive, assertActive, (stored, directory) => {
      params.register(stored, directory);
      return (publication.deliveries = stored.map(({ delivery }) => delivery));
    }),
  ).finally(() => {
    delete publication.pending;
  });
  return publication.pending;
}

function createRecordingPublication(
  expiresAt: number,
  forget: () => void,
  provenSources: readonly VerifiedFile[],
): RecordingPublication {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    forget();
    controller.abort(recordingOutputExpired());
    if (!publication.deliveries) expireUnregisteredSources(provenSources);
  }, expiresAt - Date.now()).unref();
  const publication: RecordingPublication = {
    signal: controller.signal,
    dispose() {
      controller.abort(recordingOutputExpired());
      // Verified standalone bytes remain eligible through their manifest deadline.
      if (publication.deliveries || provenSources.length === 0) clearTimeout(timer);
    },
  };
  return publication;
}

async function waitForRecordingPublication(
  signal: AbortSignal,
  expiresAt: number,
  writer: Promise<Delivery[]>,
): Promise<Delivery[]> {
  let abort!: () => void;
  const pending = new Promise<Delivery[]>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void writer.then(resolve, reject);
  });
  try {
    // The response has a deadline even when the filesystem writer cannot be interrupted.
    const outcome = await settleWithin(() => pending, expiresAt - Date.now(), { keepAlive: false });
    if (outcome.kind === 'deadline') throw recordingOutputExpired();
    return outcome.value;
  } finally {
    signal.removeEventListener('abort', abort);
  }
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
  assertActive: () => void,
  register: (files: Registration[], directory: string | undefined) => Delivery[],
): Promise<Delivery[]> {
  assertActive();
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
      assertActive();
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
      assertActive();
      if (recordingExportFileIdentity(await fs.promises.lstat(sourcePath)) !== sourceIdentity) {
        throw changedRecordingOutput();
      }
      staged.push({
        delivery,
        artifactPath,
        output: requireFileIdentity(await fs.promises.lstat(artifactPath)),
      });
    }
    assertActive();
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
