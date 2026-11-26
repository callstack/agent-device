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
    metadata.remoteCaptureTenantId === null
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
  const { producer, files, completedAt } = readVerifiedRecording(envelope);
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
