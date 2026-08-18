import {
  applicationLifecycleOperationFacts,
  snapshotRuntimeOperationFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform';

const unavailable: RuntimeOperationFact = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
});

/** Default facts for tests that are unrelated to application deployment. */
const unavailableDeploymentOperationFacts = Object.freeze({
  deployApp: unavailable,
  materializeAppSource: unavailable,
  deployMaterializedApp: unavailable,
  sendPushNotification: unavailable,
});

/** Default fact for tests that are unrelated to explicit device shutdown. */
const unavailableShutdownOperationFacts = Object.freeze({
  shutdownTarget: unavailable,
});

export const unavailableDeploymentSnapshotAndShutdownOperationFacts = Object.freeze({
  ...unavailableDeploymentOperationFacts,
  ...snapshotRuntimeOperationFacts({
    capture: unavailable,
    customActions: unavailable,
    withoutActiveApp: unavailable,
  }),
  ...unavailableShutdownOperationFacts,
  setViewport: unavailable,
});

/** Default facts for tests that are unrelated to application lifecycle commands. */
export const unavailableApplicationLifecycleOperationFacts = applicationLifecycleOperationFacts({
  resolveOpenTarget: unavailable,
  prepareApplicationOpen: unavailable,
  openApplication: unavailable,
  applyRuntimeHints: unavailable,
  clearRuntimeHints: unavailable,
  closeApplication: unavailable,
  finalizeApplicationClose: unavailable,
  prepareAppleRunner: unavailable,
  configureProviderPortReverse: unavailable,
});
