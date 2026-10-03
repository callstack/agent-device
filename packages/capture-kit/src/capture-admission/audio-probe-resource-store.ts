import { createDurableCaptureResourceStore } from '../durable-capture/index.ts';

export const audioProbeResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'audio-probe',
  fileName: 'audio-probe.resource.json',
  displayName: 'Audio probe',
});
