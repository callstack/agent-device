import fs from 'node:fs';
import { outputFileIdentity } from '@agent-device/host-kit/file';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { chunkPathAt } from '@agent-device/capture-kit/recording-output-path';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import type { ReplaySuiteRecordingArtifact } from '@agent-device/contracts/replay';
import type { SessionStore } from '../core/session-store.ts';
import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { readStoredCompletion } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import type { SessionRef } from '../core/session-state.ts';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import { errorMessage } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { tenantPublicSessionName } from '../core/session-tenant-scope.ts';
import { commitRecordingFileOutputs, leasedOutputRefusal } from '../resources/artifact-tracking.ts';
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

export function retainSessionRecording(ref: SessionRef, envelope: RecordingEnvelope): void {
  const { metadata } = envelope;
  if (
    metadata?.remoteCaptureOutput !== true ||
    metadata.remoteCaptureLifetime !== ref.lifetime.journalId ||
    metadata.remoteCaptureTenantId === null ||
    metadata.suiteRecordingArchivePath !== undefined
  )
    return;
  try {
    commitRecordingOutputs(envelope, true);
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

export function commitRecordingOutputs(envelope: RecordingEnvelope, publish: boolean) {
  return publishVerifiedRecording(envelope, readVerifiedRecording(envelope), publish);
}

function publishVerifiedRecording(
  envelope: RecordingEnvelope,
  { producer, files, completedAt }: ReturnType<typeof readVerifiedRecording>,
  publish: boolean,
) {
  return commitRecordingFileOutputs(
    files,
    producer,
    producer.tenantId
      ? tenantPublicSessionName(producer.tenantId, envelope.sessionId)
      : envelope.sessionId,
    completedAt,
    publish,
  );
}

export async function collectSuiteRecordingOutputs(
  store: SessionStore,
  ref: SessionRef,
): Promise<ReplaySuiteRecordingArtifact[]> {
  const copied: string[] = [];
  try {
    const record = screenRecordingResourceStore.read(
      screenRecordingResourceStore.resolvePath(store.resolveSessionDir(ref.address)),
    );
    if (record.status !== 'decoded' || record.envelope.lifecycle !== 'completed') return [];
    const { envelope } = record;
    const archivePath = envelope.metadata?.suiteRecordingArchivePath;
    if (
      typeof archivePath !== 'string' ||
      envelope.metadata?.remoteCaptureLifetime !== ref.lifetime.journalId
    )
      return [];

    const recording = readVerifiedRecording(envelope);
    const { completion, files } = recording;
    const archivePaths = [
      archivePath,
      ...(completion.chunks?.slice(1).map(({ index }) => chunkPathAt(archivePath, index)) ?? []),
      ...(completion.telemetryPath ? [deriveRecordingTelemetryPath(archivePath)] : []),
    ];
    for (const [index, file] of files.entries()) {
      const target = archivePaths[index]!;
      await assertArchiveSource(file.path, file.sourceIdentity);
      await fs.promises.copyFile(
        file.path,
        target,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
      );
      copied.push(target);
      await assertArchiveSource(file.path, file.sourceIdentity);
    }
    return publishVerifiedRecording(envelope, recording, true).map(
      ({ artifactId, fileName }, index) => ({
        session: ref.address,
        artifactId,
        fileName,
        path: copied[index],
      }),
    );
  } catch (error) {
    await Promise.allSettled(copied.map((file) => fs.promises.unlink(file)));
    emitDiagnostic({
      level: 'warn',
      phase: 'suite_recording_collection_failed',
      data: { session: ref.address, error: errorMessage(error) },
    });
    return [];
  }
}

async function assertArchiveSource(file: string, identity: string): Promise<void> {
  if (outputFileIdentity(await fs.promises.lstat(file)) !== identity)
    throw new Error('Recording export changed before archive publication.');
}
