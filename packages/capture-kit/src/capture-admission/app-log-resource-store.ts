import { createDurableCaptureResourceStore } from '../durable-capture/index.ts';

export const appLogResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'app-log',
  fileName: 'app-log.resource.json',
  displayName: 'App-log',
});
