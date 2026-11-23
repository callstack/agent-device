import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { errorMessage } from '@agent-device/kernel/errors';
import type { SessionRef } from '../core/session-state.ts';
import { settleCommittedFileOutputs } from '../resources/artifact-tracking.ts';
import {
  isLegacyRemoteRecordingOutput,
  recordingOutputLeaseVerifier,
} from './handlers/record-runtime-response.ts';
import { commitRecordingOutputs } from './recording-outputs.ts';

export function retainLeasedSessionRecording(
  ref: SessionRef,
  completion: ScreenRecordingCompletion,
  envelope: DurableResourceEnvelope<'screen-recording'>,
): void {
  const lease = ref.session.lease;
  const { metadata } = envelope;
  if (
    metadata?.remoteCaptureOutput !== true ||
    isLegacyRemoteRecordingOutput(completion) ||
    recordingOutputLeaseVerifier(metadata) === undefined ||
    (metadata.remoteCaptureLifetime === undefined
      ? !lease
      : metadata.remoteCaptureLifetime !== ref.lifetime.journalId)
  )
    return;
  try {
    const artifacts = commitRecordingOutputs(envelope, completion, lease?.tenantId);
    settleCommittedFileOutputs(artifacts, true);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'leased_session_recording_retention_failed',
      data: { session: ref.address, error: errorMessage(error) },
    });
  }
}
