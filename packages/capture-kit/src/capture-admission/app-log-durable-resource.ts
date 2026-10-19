import type { AppLogCompletion, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import { appLogResourceStore } from './app-log-resource-store.ts';

export const appLogDurableResource = createDurableCaptureResource<
  'app-log',
  AppLogLiveHandle,
  AppLogCompletion
>({
  resourceKind: 'app-log',
  displayName: 'app-log',
  store: appLogResourceStore,
  completionMetadata: (completion) => ({
    backend: completion.backend,
    outputPath: completion.outputPath,
    completedAt: completion.completedAt,
  }),
  failedFinishPolicy: 'dispose-on-failed-finish',
  messages: {
    noActive: 'no app log stream active',
    cleanupPendingHint:
      'Keep app-log.resource.json and retry cleanup through its exact runtime owner.',
  },
});

export { appLogResourceStore };
