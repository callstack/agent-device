import { createDurableCaptureResourceStore } from './durable-capture-resource-store.ts';

export const appLogResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'app-log',
  fileName: 'app-log.resource.json',
  displayName: 'App-log',
});
