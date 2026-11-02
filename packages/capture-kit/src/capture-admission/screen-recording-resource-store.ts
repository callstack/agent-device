import { SCREEN_RECORDING_RESOURCE_KIND } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableCaptureResourceStore } from '../durable-capture/index.ts';

export const screenRecordingResourceStore = createDurableCaptureResourceStore({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  fileName: 'screen-recording.resource.json',
  displayName: 'screen recording',
});

/**
 * The metadata key this record stores a finished recording's stop response under, beside the
 * mechanics' own facts. The writer is the kind's `completionMetadata`, the reader is
 * `screen-recording-stop-recovery.ts`; both name this key so a replay cannot miss what was written.
 */
export const SCREEN_RECORDING_COMPLETION_METADATA_KEY = 'completion';
