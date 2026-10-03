import { createDurableCaptureResourceStore } from '../durable-capture/index.ts';

export const perfCaptureResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'perf-capture',
  fileName: 'perf-capture.resource.json',
  displayName: 'Perf capture',
});
