import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  expireUnregisteredRecordingFiles,
  recordingOutputExpired,
} from '../resources/artifact-file-storage.ts';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { readReplayableStoredCompletion } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import type { SessionRef } from '../core/session-state.ts';
import type { SessionStore } from '../core/session-store.ts';
import fs from 'node:fs';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { recordingExportFileIdentity } from '@agent-device/capture-kit/screen-recording-session-resource';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { tenantPublicSessionName } from '../core/session-tenant-scope.ts';
import {
  ARTIFACT_CLEANUP_TIMEOUT_MS,
  commitRecordingFileOutputs,
  leasedOutputRefusal,
} from '../resources/artifact-tracking.ts';
import {
  isLegacyRemoteRecordingOutput,
  recordingOutputLeaseVerifier,
  recordingStopArtifacts,
} from './handlers/record-runtime-response.ts';

export async function commitRecordingOutputs(
  envelope: DurableResourceEnvelope<'screen-recording'>,
  completion: ScreenRecordingCompletion,
  legacyTenant?: string,
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
    const artifactPath = artifact.path!;
    const stat = fs.lstatSync(artifactPath, { throwIfNoEntry: false });
    if (!stat) throw recordingOutputExpired();
    if (
      !stat.isFile() ||
      (proof && proof.identities[index] !== recordingExportFileIdentity(stat))
    ) {
      throw new AppError('COMMAND_FAILED', 'Recording export is missing or has changed.');
    }
    return { ...artifact, path: artifactPath, stat };
  });
  const tenantId = recordingProducerTenant(envelope, owner, proof !== undefined, legacyTenant);
  return commitRecordingFileOutputs(
    files,
    {
      lifetimeId: proof?.lifetimeId ?? envelope.fence.token,
      tenantId,
      leaseVerifier: owner,
    },
    tenantId ? tenantPublicSessionName(tenantId, envelope.sessionId) : envelope.sessionId,
    proof?.completedAt ?? Date.now(),
    metadata?.remoteCaptureArchive !== true,
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

export function expireFailedRecordingExport(
  envelope: DurableResourceEnvelope<'screen-recording'>,
  completion: ScreenRecordingCompletion,
): void {
  if (envelope.metadata?.remoteCaptureArchive === true) return;
  const proof = readRecordingExportProof(envelope);
  if (!proof) return;
  const artifacts = recordingStopArtifacts(completion);
  if (artifacts.length !== proof.identities.length) return;
  expireUnregisteredRecordingFiles(
    artifacts.flatMap(({ path }, index) => {
      const sourceIdentity = proof.identities[index];
      return path && typeof sourceIdentity === 'string'
        ? [{ sourcePath: path, sourceIdentity }]
        : [];
    }),
    proof.completedAt + ARTIFACT_CLEANUP_TIMEOUT_MS,
  );
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
      ? await commitRecordingOutputs(envelope, completion)
      : [];
  return artifacts.map((artifact, index) => ({
    session: ref.address,
    path: artifact.path!,
    artifactId: committed[index]?.artifactId,
  }));
}
