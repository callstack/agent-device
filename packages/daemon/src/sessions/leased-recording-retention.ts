import fs from 'node:fs';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { errorMessage } from '@agent-device/kernel/errors';
import type { SessionRef } from '../core/session-state.ts';
import { tenantPublicSessionName } from '../core/session-tenant-scope.ts';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../resources/artifact-tracking.ts';
import {
  isDaemonOwnedRecordingOutput,
  recordingStopArtifacts,
  recordingOutputLeaseVerifier,
} from './handlers/record-runtime-response.ts';

/**
 * Keeps the export of a recording that a leased session's teardown finished, so a request that sends
 * the ended lease's id can still download it (ADR 0024 rule 1). Remote admission marks session-owned output in the durable
 * envelope. Remote client exports served by local HTTP use the generated daemon temp path.
 * A local caller's export already sits at the path that the caller named.
 */
export function retainLeasedSessionRecording(
  ref: SessionRef,
  completion: ScreenRecordingCompletion,
  metadata: DurableResourceEnvelope['metadata'],
): void {
  const lease = ref.session.lease;
  if (!lease || !isDaemonOwnedRecordingOutput(completion, metadata?.remoteCaptureOutput === true))
    return;
  const owner = recordingOutputLeaseVerifier(metadata);
  if (owner === undefined) return;
  const storedTenant = metadata?.remoteCaptureTenantId;
  const tenantId = typeof storedTenant === 'string' ? storedTenant : undefined;
  const sessionName = tenantPublicSessionName(lease.tenantId, ref.address);
  const artifacts = recordingStopArtifacts(completion).filter(
    (artifact) => typeof artifact.path === 'string',
  );
  const artifactIds: string[] = [];
  try {
    for (const artifact of artifacts) {
      artifactIds.push(
        trackDownloadableArtifact({
          artifactPath: artifact.path!,
          tenantId,
          ...(owner === null ? {} : { leaseVerifier: owner }),
          artifactType: artifact.artifactType,
          fileName: artifact.fileName,
          sessionName,
        }),
      );
    }
  } catch (error) {
    for (const artifactId of artifactIds) cleanupDownloadableArtifact(artifactId);
    for (const artifact of artifacts) removeBestEffort(artifact.path!);
    emitDiagnostic({
      level: 'warn',
      phase: 'leased_session_recording_retention_failed',
      data: { session: ref.address, leaseId: lease.leaseId, error: errorMessage(error) },
    });
    return;
  }
  emitDiagnostic({
    level: 'info',
    phase: 'leased_session_recording_retained',
    data: { session: ref.address, sessionName, leaseId: lease.leaseId, artifactIds },
  });
}

function removeBestEffort(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A file that cannot be removed must not stop the removal of the others.
  }
}
