import fs from 'node:fs';
import path from 'node:path';
import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { settleWithin } from '@agent-device/host-kit/settle-within';
import {
  finishPendingScreenRecordingProof,
  recordingExportFileIdentity,
} from '@agent-device/capture-kit/screen-recording-session-resource';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import {
  readReplayableStoredCompletion,
  readStoredCompletion,
} from '@agent-device/capture-kit/screen-recording-stop-recovery';
import type { ReplaySuiteRecordingArtifact } from '@agent-device/contracts/replay';
import type { SessionRef } from '../core/session-state.ts';
import type { SessionStore } from '../core/session-store.ts';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { chunkPathAt } from '@agent-device/capture-kit/recording-output-path';
import { tenantPublicSessionName } from '../core/session-tenant-scope.ts';
import {
  ARTIFACT_CLEANUP_TIMEOUT_MS,
  commitRecordingFileOutputs,
  leasedOutputRefusal,
  settleRecordingArchiveCopy,
  recordingRegistrySignal,
} from '../resources/artifact-tracking.ts';
import {
  recordingOutputLeaseVerifier,
  recordingStopArtifacts,
} from './handlers/record-runtime-response.ts';

type RecordingEnvelope = DurableResourceEnvelope<'screen-recording'>;

function readVerifiedRecording(envelope: RecordingEnvelope) {
  const { metadata } = envelope;
  const completion = readStoredCompletion(metadata);
  const verified = metadata?.remoteCaptureExport;
  if (
    envelope.lifecycle !== 'completed' ||
    !completion ||
    metadata?.remoteCaptureOutput !== true ||
    completion.outPath !== metadata.remoteCapturePath ||
    metadata.remoteCaptureReservation !== envelope.fence.token ||
    !isRecord(verified) ||
    !Array.isArray(verified.identities) ||
    typeof verified.completedAt !== 'number' ||
    !Number.isFinite(verified.completedAt)
  )
    throw leasedOutputRefusal('Recording');
  const { identities } = verified;
  const artifacts = recordingStopArtifacts(completion);
  if (artifacts.length !== identities.length) throw leasedOutputRefusal('Recording');
  const files = artifacts.map((artifact, index) => {
    const sourceIdentity = identities[index];
    if (typeof sourceIdentity !== 'string') throw leasedOutputRefusal('Recording');
    const artifactId = `${envelope.fence.token}-${index + 1}`;
    return { ...artifact, path: artifact.path!, sourceIdentity, artifactId };
  });
  return {
    completion,
    files,
    completedAt: verified.completedAt,
    producer: recordingProducer(metadata),
  };
}

export async function retainSessionRecording(
  ref: SessionRef,
  envelope: RecordingEnvelope,
): Promise<void> {
  const { metadata } = envelope;
  if (
    metadata?.remoteCaptureOutput !== true ||
    metadata.remoteCaptureLifetime !== ref.lifetime.journalId
  )
    return;
  try {
    await commitRecordingOutputs(
      envelope,
      metadata.remoteCaptureTenantId === null ? 'retain' : 'live',
    );
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'leased_session_recording_retention_failed',
      data: {
        session: ref.address,
        error: errorMessage(error),
        hasExportProof: metadata.remoteCaptureExport !== undefined,
      },
    });
  }
}

function recordingProducer(metadata: RecordingEnvelope['metadata']) {
  const leaseVerifier = recordingOutputLeaseVerifier(metadata);
  const lifetimeId = metadata?.remoteCaptureLifetime;
  const stored = metadata?.remoteCaptureTenantId;
  const tenantId = normalizeTenantId(stored);
  if (
    leaseVerifier === undefined ||
    typeof lifetimeId !== 'string' ||
    (stored === null ? leaseVerifier !== null : !tenantId || tenantId !== stored)
  ) {
    throw leasedOutputRefusal('Recording');
  }
  return { lifetimeId, tenantId, leaseVerifier };
}

function publishVerifiedRecording(
  envelope: RecordingEnvelope,
  recording: ReturnType<typeof readVerifiedRecording>,
  delivery?: 'publish' | 'retain' | 'await-archive',
) {
  const { producer, files, completedAt } = recording;
  return commitRecordingFileOutputs(
    files,
    producer,
    producer.tenantId
      ? tenantPublicSessionName(producer.tenantId, envelope.sessionId)
      : envelope.sessionId,
    completedAt,
    envelope.fence.token,
    delivery,
  );
}

export async function commitRecordingOutputs(
  envelope: RecordingEnvelope,
  context: 'live' | 'replay' | 'retain',
) {
  const delivery =
    context === 'live' && typeof envelope.metadata?.suiteRecordingArchivePath === 'string'
      ? 'await-archive'
      : context === 'retain'
        ? 'retain'
        : 'publish';
  return publishVerifiedRecording(envelope, readVerifiedRecording(envelope), delivery);
}

export async function collectSuiteRecordingOutputs(store: SessionStore, ref: SessionRef) {
  try {
    return await readSuiteRecordingOutputs(store, ref);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'suite_recording_collection_failed',
      data: { session: ref.address, error: errorMessage(error) },
    });
    return [];
  }
}

async function readSuiteRecordingOutputs(
  store: SessionStore,
  ref: SessionRef,
): Promise<ReplaySuiteRecordingArtifact[]> {
  const resourcePath = screenRecordingResourceStore.resolvePath(
    store.resolveSessionDir(ref.address),
  );
  const record = screenRecordingResourceStore.read(resourcePath);
  if (record.status !== 'decoded') return [];
  let { envelope } = record;
  if (envelope.metadata?.suiteRecordingLifetime !== ref.lifetime.journalId) return [];
  if (envelope.metadata.phase === 'export-proof-pending') {
    envelope = await finishPendingScreenRecordingProof(resourcePath, envelope);
  }
  if (envelope.lifecycle !== 'completed') return [];
  if (envelope.metadata?.remoteCaptureOutput !== true) {
    const completion = readReplayableStoredCompletion(envelope.metadata);
    return completion
      ? recordingStopArtifacts(completion).map(({ path }) => ({ session: ref.address, path }))
      : [];
  }

  const recording = readVerifiedRecording(envelope);
  const archivePath = envelope.metadata.suiteRecordingArchivePath;
  const hasArchive = typeof archivePath === 'string';
  const committed = await publishVerifiedRecording(
    envelope,
    recording,
    hasArchive ? 'await-archive' : 'publish',
  );
  let paths: readonly string[] = [];
  if (hasArchive) {
    const signal = recordingRegistrySignal();
    try {
      paths = await copySuiteRecording(archivePath, recording);
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'suite_recording_archive_copy_failed',
        data: { session: ref.address, error: errorMessage(error) },
      });
    } finally {
      if (!signal.aborted) settleRecordingArchiveCopy(recording.files);
    }
  }
  return committed.map(({ artifactId, fileName }, index) => ({
    session: ref.address,
    artifactId,
    fileName,
    path: paths[index],
  }));
}

async function copySuiteRecording(
  archivePath: string,
  { files, completedAt, completion }: ReturnType<typeof readVerifiedRecording>,
): Promise<string[]> {
  const expiresAt = completedAt + ARTIFACT_CLEANUP_TIMEOUT_MS;
  const paths = [
    archivePath,
    ...(completion.chunks?.slice(1).map(({ index }) => chunkPathAt(archivePath, index)) ?? []),
    ...(completion.telemetryPath ? [deriveRecordingTelemetryPath(archivePath)] : []),
  ];
  const signal = recordingRegistrySignal();
  const copy = async () => {
    const scratch = await fs.promises.mkdtemp(
      path.join(path.dirname(completion.outPath), '.recording-archive-'),
    );
    try {
      const staged = [];
      for (const [index, file] of files.entries()) {
        signal.throwIfAborted();
        if (Date.now() >= expiresAt)
          throw new AppError('COMMAND_FAILED', 'Recording archive copy expired.');
        const target = path.join(scratch, String(index));
        await verifyArchiveSource(file);
        await fs.promises.copyFile(
          file.path,
          target,
          fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
        );
        await verifyArchiveSource(file);
        staged.push(target);
      }
      signal.throwIfAborted();
      if (Date.now() >= expiresAt)
        throw new AppError('COMMAND_FAILED', 'Recording archive copy expired.');
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      const linked: string[] = [];
      try {
        for (const [index, destination] of paths.entries()) {
          fs.linkSync(staged[index]!, destination);
          linked.push(destination);
        }
      } catch (error) {
        for (const destination of linked) fs.unlinkSync(destination);
        throw error;
      }
      return paths;
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  };
  let abort!: () => void;
  const pending = new Promise<string[]>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else void copy().then(resolve, reject);
  });
  try {
    const outcome = await settleWithin(() => pending, expiresAt - Date.now(), { keepAlive: false });
    if (outcome.kind === 'deadline')
      throw new AppError('COMMAND_FAILED', 'Recording archive copy expired.');
    return outcome.value;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function verifyArchiveSource(file: { path: string; sourceIdentity: string }) {
  if (recordingExportFileIdentity(await fs.promises.lstat(file.path)) !== file.sourceIdentity)
    throw new AppError(
      'COMMAND_FAILED',
      'Recording export changed during archive materialization.',
    );
}
