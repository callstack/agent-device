import { createDurableCaptureResourceStore } from '@agent-device/capture-kit/durable-capture';

export const audioProbeResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'audio-probe',
  fileName: 'audio-probe.resource.json',
  displayName: 'Audio probe',
});
