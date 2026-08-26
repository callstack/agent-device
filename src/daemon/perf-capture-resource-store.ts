import { createDurableCaptureResourceStore } from './durable-capture-resource-store.ts';

export const perfCaptureResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'perf-capture',
  fileName: 'perf-capture.resource.json',
  displayName: 'Perf capture',
});
