import { createDurableCaptureResourceStore } from './durable-capture-resource-store.ts';

export const audioProbeResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'audio-probe',
  fileName: 'audio-probe.resource.json',
  displayName: 'Audio probe',
});
