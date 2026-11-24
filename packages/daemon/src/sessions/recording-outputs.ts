import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { readReplayableStoredCompletion } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import type { SessionRef } from '../core/session-state.ts';
import type { SessionStore } from '../core/session-store.ts';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { tenantPublicSessionName } from '../core/session-tenant-scope.ts';
import { commitRecordingFileOutputs, leasedOutputRefusal } from '../resources/artifact-tracking.ts';
import {
  isLegacyRemoteRecordingOutput,
  recordingOutputLeaseVerifier,
  recordingStopArtifacts,
} from './handlers/record-runtime-response.ts';

export async function commitRecordingOutputs(
  envelope: DurableResourceEnvelope<'screen-recording'>,
  completion: ScreenRecordingCompletion,
  options?: { legacyTenant?: string; replay?: boolean },
) {
  const { metadata } = envelope;
  const owner = recordingOutputLeaseVerifier(metadata);
  if (owner === undefined || isLegacyRemoteRecordingOutput(completion)) {
    throw leasedOutputRefusal('Recording');
  }
  const proof = readRecordingExportProof(envelope);
  const artifacts = recordingStopArtifacts(completion);
  if (proof && proof.identities.length !== artifacts.length) {
    throw new AppError('COMMAND_FAILED', 'Recording export could not be verified.');
  }
  const files = artifacts.map((artifact, index) => {
    const sourceIdentity = proof?.identities[index];
    if (proof && typeof sourceIdentity !== 'string') {
      throw new AppError('COMMAND_FAILED', 'Recording export could not be verified.');
    }
    return {
      ...artifact,
      path: artifact.path!,
      sourceIdentity: typeof sourceIdentity === 'string' ? sourceIdentity : undefined,
    };
  });
  const tenantId = recordingProducerTenant(
    envelope,
    owner,
    proof !== undefined,
    options?.legacyTenant,
  );
  return commitRecordingFileOutputs(
    files,
    {
      lifetimeId: proof?.lifetimeId ?? envelope.fence.token,
      tenantId,
      leaseVerifier: owner,
    },
    tenantId ? tenantPublicSessionName(tenantId, envelope.sessionId) : envelope.sessionId,
    proof?.completedAt ?? Date.now(),
    metadata?.remoteCaptureArchive !== true
      ? 'original'
      : options?.replay
        ? 'archive-replay'
        : 'archive',
  );
}

function recordingProducerTenant(
  envelope: DurableResourceEnvelope<'screen-recording'>,
  owner: string | null,
  verified: boolean,
  legacyTenant?: string,
): string | undefined {
  const stored = envelope.metadata?.remoteCaptureTenantId;
  const tenant = normalizeTenantId(stored);
  if (!verified) return owner === null && legacyTenant ? legacyTenant : (tenant ?? legacyTenant);
  if (stored === null && owner === null) return undefined;
  if (!tenant || tenant !== stored) throw leasedOutputRefusal('Recording');
  return tenant;
}

function readRecordingExportProof(envelope: DurableResourceEnvelope<'screen-recording'>) {
  if (envelope.lifecycle !== 'completed') {
    throw new AppError('COMMAND_FAILED', 'Recording export could not be verified.');
  }
  const { metadata } = envelope;
  const lifetimeId = metadata?.remoteCaptureLifetime;
  if (lifetimeId === undefined && metadata?.remoteCapturePath === undefined) return undefined;
  const verified = metadata?.remoteCaptureExport;
  if (
    typeof lifetimeId !== 'string' ||
    !isRecord(verified) ||
    !Array.isArray(verified.identities) ||
    typeof verified.completedAt !== 'number' ||
    !Number.isFinite(verified.completedAt)
  ) {
    throw new AppError('COMMAND_FAILED', 'Recording export could not be verified.');
  }
  return { lifetimeId, identities: verified.identities, completedAt: verified.completedAt };
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

async function readSuiteRecordingOutputs(store: SessionStore, ref: SessionRef) {
  const record = screenRecordingResourceStore.read(
    screenRecordingResourceStore.resolvePath(store.resolveSessionDir(ref.address)),
  );
  if (record.status !== 'decoded' || record.envelope.lifecycle !== 'completed') return [];
  const { envelope } = record;
  if (envelope.metadata?.suiteRecordingLifetime !== ref.lifetime.journalId) return [];
  const completion = readReplayableStoredCompletion(envelope.metadata);
  if (!completion) return [];
  const artifacts = recordingStopArtifacts(completion);
  const committed =
    envelope.metadata.remoteCaptureOutput === true
      ? await commitRecordingOutputs(envelope, completion, { replay: true })
      : [];
  return artifacts.map((artifact, index) => ({
    session: ref.address,
    path: artifact.path!,
    artifactId: committed[index]?.artifactId,
  }));
}
