import { createDurableCaptureResourceStore } from '@agent-device/capture-kit/durable-capture';

export const appLogResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'app-log',
  fileName: 'app-log.resource.json',
  displayName: 'App-log',
});
