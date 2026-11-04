import { SCREEN_RECORDING_RESOURCE_KIND } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableCaptureResourceStore } from '../durable-capture/index.ts';

export const screenRecordingResourceStore = createDurableCaptureResourceStore({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  fileName: 'screen-recording.resource.json',
  displayName: 'screen recording',
});

/** Whether an open durable recording can require MP4 validation after daemon restart. */
export function hasRecordingRecoveryNeedingValidator(sessionsDir: string): boolean {
  return screenRecordingResourceStore.list(sessionsDir).some((resourcePath) => {
    const record = screenRecordingResourceStore.read(resourcePath);
    if (record.status !== 'decoded' || record.envelope.lifecycle !== 'open') return false;
    const outputPath = record.envelope.descriptor.body.outputPath;
    return typeof outputPath === 'string' && !outputPath.toLowerCase().endsWith('.webm');
  });
}

/**
 * The metadata key this record stores a finished recording's stop response under, beside the
 * mechanics' own facts. The writer is the kind's `completionMetadata`, the reader is
 * `screen-recording-stop-recovery.ts`; both name this key so a replay cannot miss what was written.
 */
export const SCREEN_RECORDING_COMPLETION_METADATA_KEY = 'completion';
export const SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY = 'deviceClaimToken';

export const SCREEN_RECORDING_CLAIM_BINDING_VERSION_KEY = 'deviceClaimBindingVersion';
