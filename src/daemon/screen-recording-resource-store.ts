import { SCREEN_RECORDING_RESOURCE_KIND } from '@agent-device/contracts/platform';
import { createDurableCaptureResourceStore } from './durable-capture-resource-store.ts';

export const screenRecordingResourceStore = createDurableCaptureResourceStore({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  fileName: 'screen-recording.resource.json',
  displayName: 'screen recording',
});
