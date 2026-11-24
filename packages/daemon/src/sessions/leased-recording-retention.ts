import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { errorMessage } from '@agent-device/kernel/errors';
import type { SessionRef } from '../core/session-state.ts';
import {
  isLegacyRemoteRecordingOutput,
  recordingOutputLeaseVerifier,
} from './handlers/record-runtime-response.ts';
import { commitRecordingOutputs } from './recording-outputs.ts';

export async function retainLeasedSessionRecording(
  ref: SessionRef,
  completion: ScreenRecordingCompletion,
  envelope: DurableResourceEnvelope<'screen-recording'>,
): Promise<void> {
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
    await commitRecordingOutputs(envelope, completion, { legacyTenant: lease?.tenantId });
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
