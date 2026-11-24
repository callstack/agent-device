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
  const { metadata } = envelope;
  if (
    metadata?.remoteCaptureOutput !== true ||
    isLegacyRemoteRecordingOutput(completion) ||
    metadata.remoteCaptureLifetime !== ref.lifetime.journalId
  )
    return;
  try {
    const hostGlobal =
      recordingOutputLeaseVerifier(metadata) === null && metadata.remoteCaptureTenantId === null;
    await commitRecordingOutputs(envelope, hostGlobal);
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
