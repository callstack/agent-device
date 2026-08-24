import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { scrollRuntimeOperationFacts } from '@agent-device/contracts/scroll-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { touchRuntimeOperationFacts } from '@agent-device/contracts/touch-runtime';

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
  ...screenshotRuntimeOperationFacts({ capture: unavailable }),
  findText: unavailable,
  findSelector: unavailable,
  setViewport: unavailable,
  focusPoint: unavailable,
  typeText: unavailable,
  ...touchRuntimeOperationFacts({
    tap: unavailable,
    longPress: unavailable,
    hover: unavailable,
    fill: unavailable,
    tapElementSelector: unavailable,
  }),
  ...gestureRuntimeOperationFacts({
    plan: unavailable,
    directionalFling: unavailable,
    multiTouch: unavailable,
    targetAuthoredDrag: unavailable,
    viewport: unavailable,
  }),
  ...scrollRuntimeOperationFacts({ scroll: unavailable }),
  ...elementTextRuntimeOperationFacts({ readTextAtPoint: unavailable }),
  back: unavailable,
  home: unavailable,
  setOrientation: unavailable,
  tvRemote: unavailable,
  keyboardStatus: unavailable,
  keyboardDismiss: unavailable,
  keyboardEnter: unavailable,
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
