import { createDurableCaptureResourceStore } from './durable-capture-resource-store.ts';

export const appLogResourceStore = createDurableCaptureResourceStore({
  resourceKind: 'app-log',
  fileName: 'app-log.resource.json',
  displayName: 'App-log',
});

export const resolveAppLogResourcePath = appLogResourceStore.resolvePath;
export const readAppLogResourceRecord = appLogResourceStore.read;
export const writeAppLogResourceRecord = appLogResourceStore.write;
export const listAppLogResourcePaths = appLogResourceStore.list;
