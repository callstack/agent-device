import { createDurableCaptureResourceStore } from '@agent-device/capture-kit/durable-capture';

export const perfCaptureResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'perf-capture',
  fileName: 'perf-capture.resource.json',
  displayName: 'Perf capture',
});
