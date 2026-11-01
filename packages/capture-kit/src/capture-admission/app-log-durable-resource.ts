import type { AppLogCompletion, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import type { JsonObject } from '@agent-device/contracts/client';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import { appLogResourceStore } from './app-log-resource-store.ts';

const LOG_BACKENDS: readonly AppLogCompletion['backend'][] = [
  'ios-simulator',
  'ios-device',
  'android',
  'harmonyos',
  'macos',
];

/**
 * The stopped stream answered with the log path it flushed to, its backend, and when it stopped — and
 * those are exactly the facts this kind journals on commit, so a caller that reaches the committed
 * record can be answered from them. Anything else on the record is the mechanics' own state, which is
 * not a completion: a record that cannot name all three is refused rather than answered.
 */
function readAppLogStoredCompletion(
  metadata: JsonObject | undefined,
): AppLogCompletion | undefined {
  const backend = metadata?.backend;
  const outputPath = metadata?.outputPath;
  const completedAt = metadata?.completedAt;
  if (
    typeof backend !== 'string' ||
    !LOG_BACKENDS.includes(backend as AppLogCompletion['backend']) ||
    typeof outputPath !== 'string' ||
    outputPath.length === 0 ||
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt)
  ) {
    return undefined;
  }
  return {
    backend: backend as AppLogCompletion['backend'],
    outputPath,
    completedAt,
  };
}

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
  completionFromMetadata: readAppLogStoredCompletion,
  failedFinishPolicy: 'dispose-on-failed-finish',
  messages: {
    noActive: 'no app log stream active',
    cleanupPendingHint:
      'Keep app-log.resource.json and retry cleanup through its exact runtime owner.',
  },
});

export { appLogResourceStore };
