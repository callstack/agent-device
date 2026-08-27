import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { audioProbeRuntimeOperationFacts } from '@agent-device/contracts/audio-probe-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import type {
  RuntimeOperationUnavailability,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { scrollRuntimeOperationFacts } from '@agent-device/contracts/scroll-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { touchRuntimeOperationFacts } from '@agent-device/contracts/touch-runtime';
import { perfRuntimeOperationFacts } from '@agent-device/contracts/perf-runtime';

const unavailable: RuntimeOperationUnavailability = Object.freeze({
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
  readClipboard: unavailable,
  writeClipboard: unavailable,
  appSwitcher: unavailable,
  triggerAppEvent: unavailable,
  setSetting: unavailable,
  readAlert: unavailable,
  awaitAlert: unavailable,
  acceptAlert: unavailable,
  dismissAlert: unavailable,
  ...audioProbeRuntimeOperationFacts({ capture: unavailable, query: unavailable }),
  ...perfRuntimeOperationFacts({
    frames: unavailable,
    memorySample: unavailable,
    memorySnapshot: unavailable,
    nativeCapture: unavailable,
    profileReport: unavailable,
  }),
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

/**
 * Complete fail-closed facts for tests that exercise only a small runtime surface.
 *
 * Production owners must classify each required family explicitly. Tests instead start from this
 * single complete record and override only the cells whose behavior they are proving.
 */
export function createUnavailableRuntimeFactsForTest(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  fact: RuntimeOperationUnavailability = unavailable,
) {
  return createUnavailablePlatformRuntimeFacts(device, owner, {
    appLog: fact,
    network: fact,
    screenshot: fact,
    viewport: fact,
    focus: fact,
    gesture: fact,
    scroll: fact,
    typeText: fact,
    touch: fact,
    elementText: fact,
    back: fact,
    home: fact,
    orientation: fact,
    tvRemote: fact,
    keyboardStatus: fact,
    keyboardDismiss: fact,
    keyboardEnter: fact,
    readClipboard: fact,
    writeClipboard: fact,
    appSwitcher: fact,
    triggerAppEvent: fact,
    setSetting: fact,
    readAlert: fact,
    awaitAlert: fact,
    acceptAlert: fact,
    dismissAlert: fact,
    audioProbeCapture: fact,
    audioProbeQuery: fact,
    lifecycle: applicationLifecycleOperationFacts({
      resolveOpenTarget: fact,
      prepareApplicationOpen: fact,
      openApplication: fact,
      applyRuntimeHints: fact,
      clearRuntimeHints: fact,
      closeApplication: fact,
      finalizeApplicationClose: fact,
      prepareAppleRunner: fact,
      configureProviderPortReverse: fact,
    }),
  });
}
