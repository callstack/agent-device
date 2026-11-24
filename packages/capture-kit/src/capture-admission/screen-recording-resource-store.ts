import { SCREEN_RECORDING_RESOURCE_KIND } from '@agent-device/contracts/screen-recording-runtime';
import type { JsonObject } from '@agent-device/contracts/client';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createDurableCaptureResourceStore } from '../durable-capture/index.ts';

export class RecordingProofIoError extends AppError {
  readonly evidence?: JsonObject;

  constructor(evidence?: JsonObject) {
    super('COMMAND_FAILED', 'Recording ownership proof could not be read.', { retriable: true });
    this.evidence = evidence;
  }
}

export function recordingCheckpointError(error: unknown): RecordingProofIoError {
  emitDiagnostic({
    level: 'warn',
    phase: 'screen_recording_proof_io_failed',
    data: { error: errorMessage(error) },
  });
  return new RecordingProofIoError();
}

export const screenRecordingResourceStore = createDurableCaptureResourceStore({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  fileName: 'screen-recording.resource.json',
  displayName: 'screen recording',
  checkpointError: recordingCheckpointError,
});

/**
 * The metadata key this record stores a finished recording's stop response under, beside the
 * mechanics' own facts. The writer is the kind's `completionMetadata`, the reader is
 * `screen-recording-stop-recovery.ts`; both name this key so a replay cannot miss what was written.
 */
export const SCREEN_RECORDING_COMPLETION_METADATA_KEY = 'completion';
