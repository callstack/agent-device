import fs from 'node:fs';
import path from 'node:path';
import { isRemoteTempArtifactPath } from '@agent-device/contracts/daemon-http';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { errorMessage } from '@agent-device/kernel/errors';
import type { SessionRef } from '../core/session-state.ts';
import { tenantPublicSessionName } from '../core/session-tenant-scope.ts';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../resources/artifact-tracking.ts';
import { recordingStopArtifacts } from './handlers/record-runtime-response.ts';

/**
 * Keeps the export of a recording that a leased session's teardown finished, so the tenant can
 * still download it (ADR 0024 rule 1). Only a remote caller's export qualifies: it sits at a
 * daemon temp path that only a downloadable-artifact entry ever removes. A local caller's export
 * already sits at the path that the caller named.
 */
export function retainLeasedSessionRecording(
  ref: SessionRef,
  completion: ScreenRecordingCompletion,
): void {
  const lease = ref.session.lease;
  if (!lease || !isRemoteRecordingExport(completion)) return;
  const sessionName = tenantPublicSessionName(lease.tenantId, ref.address);
  const artifacts = recordingStopArtifacts(completion).filter(
    (artifact) => typeof artifact.path === 'string' && artifact.localPath,
  );
  const artifactIds: string[] = [];
  try {
    for (const artifact of artifacts) {
      artifactIds.push(
        trackDownloadableArtifact({
          artifactPath: artifact.path!,
          tenantId: lease.tenantId,
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

function isRemoteRecordingExport(completion: ScreenRecordingCompletion): boolean {
  return (
    completion.clientOutPath !== undefined &&
    isRemoteTempArtifactPath(completion.outPath, 'recording', path.extname(completion.outPath))
  );
}
