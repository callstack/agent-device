import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { type RuntimeFacts, unavailableFact } from '@agent-device/contracts/platform-runtime';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import { audioProbeRuntimeOperationFacts } from '@agent-device/contracts/audio-probe-runtime';
import { perfRuntimeOperationFacts } from '@agent-device/contracts/perf-runtime';
import { isSupportedRevylRuntimeDevice } from './device.ts';
import {
  liveSessionUnavailable,
  revylInteractionOperationFacts,
  revylNavigationOperationFacts,
  revylUnsupportedOperationFacts,
  REVYL_FOLD_UNAVAILABLE,
  REVYL_TELEPHONY_UNAVAILABLE,
} from './interaction-operations.ts';

const available = Object.freeze({ available: true } as const);

/** Revyl installs the app it is given when the session starts; the worker's install action takes a URL. */
const installUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl installs an app when the session starts. Pass --provider-app <URL> to connect, and run open afterwards.',
);
const pushUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not deliver a push notification to a session.',
);
const uninstallUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not uninstall an app from a session.',
);
const appStateUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not report which app the device has in the foreground.',
);
/**
 * The worker's `device_logs` action streams the platform's own log output, which is not the app's
 * os_log or logcat stream the app-log owner reads and reattaches to.
 */
const appLogUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose an app log stream.',
);
/** `install_status` reports one install the worker performed, not the device's installed apps. */
const appInventoryUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not report the apps installed on a session.',
);
const networkUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose a network capture for a session.',
);
const recordingUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl streams the screen for its own viewer and does not expose a recording.',
);
const customSnapshotUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Custom snapshot actions are available only on a local iOS runner.',
);
const viewportUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl rents a device at the size its model has.',
);
/**
 * A point read needs a local tool — adb, the XCUITest runner — and the worker has no such action.
 * Provider ownership never borrows the local family's read, so a text wait polls the captured tree.
 */
const elementTextUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl-owned devices read element text from the captured tree only.',
);
const headlessUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Headless boot is unavailable for provider-owned devices.',
);
const prepareUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Apple runner preparation is unavailable for Revyl-owned devices.',
);
/** Revyl rents the device to one session, so there is no target to start or stop by hand. */
const shutdownUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl owns the target lifecycle for provider-owned devices.',
);
const runtimeHintsUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Runtime hints are not applied to provider-owned devices.',
);
const portReverseUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose port reverse; publish the app server at a public URL instead.',
);
const audioProbeUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose the audio probe.',
);
/** Only the app the session started with can be named, so an unnamed open target cannot be resolved. */
const openTargetUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl open requires the app the session was started with.',
);
const closeTargetUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl close requires the app the session was started with.',
);

/**
 * The lifecycle cells, which the owner also reports for the not-live-session fallback. Revyl's
 * launch and kill actions answer for the app the session started with, so opening and closing share
 * one verdict; the runner, hint, and port-reverse legs belong to a local host and never to a
 * rented device.
 */
export function revylLifecycleFacts(device: DeviceInfo, live: boolean) {
  const target = isSupportedRevylRuntimeDevice(device)
    ? live
      ? available
      : liveSessionUnavailable
    : openTargetUnavailable;
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: target,
    prepareApplicationOpen: target,
    openApplication: target,
    applyRuntimeHints: runtimeHintsUnavailable,
    clearRuntimeHints: runtimeHintsUnavailable,
    closeApplication: isSupportedRevylRuntimeDevice(device)
      ? live
        ? available
        : liveSessionUnavailable
      : closeTargetUnavailable,
    finalizeApplicationClose: isSupportedRevylRuntimeDevice(device)
      ? live
        ? available
        : liveSessionUnavailable
      : closeTargetUnavailable,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}

/** The facts of a live Revyl session: what its device-proxy actions carry, and what they do not. */
export function revylFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  return Object.freeze({
    device: { ...deviceShape(device), providerMode: 'provider-runtime' },
    operations: {
      appLogInspect: appLogUnavailable,
      appLogDoctor: appLogUnavailable,
      appLogStart: appLogUnavailable,
      appLogReattach: appLogUnavailable,
      appLogCleanup: appLogUnavailable,
      listApps: appInventoryUnavailable,
      deployApp: installUnavailable,
      materializeAppSource: installUnavailable,
      deployMaterializedApp: installUnavailable,
      sendPushNotification: pushUnavailable,
      uninstallApp: uninstallUnavailable,
      appState: appStateUnavailable,
      networkDump: networkUnavailable,
      screenRecordingStart: recordingUnavailable,
      screenRecordingReattach: recordingUnavailable,
      screenRecordingCleanup: recordingUnavailable,
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions: customSnapshotUnavailable,
        withoutActiveApp: available,
      }),
      ...screenshotRuntimeOperationFacts({ capture: available }),
      // A live selector read needs the local reader's rescue hook, which a rented device has none of,
      // so both text readings answer from the captured tree like `elementText` does.
      ...selectorObservationRuntimeOperationFacts({
        findText: elementTextUnavailable,
        querySelector: elementTextUnavailable,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
      ...revylInteractionOperationFacts(),
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementTextUnavailable }),
      ...revylNavigationOperationFacts(),
      ...revylUnsupportedOperationFacts(),
      ...audioProbeRuntimeOperationFacts({
        capture: audioProbeUnavailable,
        query: audioProbeUnavailable,
      }),
      ...perfRuntimeOperationFacts({
        frames: elementTextUnavailable,
        memorySample: elementTextUnavailable,
        memorySnapshot: elementTextUnavailable,
        nativeCapture: elementTextUnavailable,
        profileReport: elementTextUnavailable,
      }),
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      shutdownTarget: shutdownUnavailable,
      ...revylLifecycleFacts(device, true),
    },
  });
}

/**
 * The cells the not-live fallback reports, one per family. Revyl keeps nothing that reaches the
 * device when its session is gone, so the owner builds that whole facts value through the shared
 * unavailable-facts helper rather than overriding the live facts cell by cell.
 */
export const revylUnavailableCells = Object.freeze({
  appLog: liveSessionUnavailable,
  appState: liveSessionUnavailable,
  appDeployment: liveSessionUnavailable,
  apps: liveSessionUnavailable,
  network: liveSessionUnavailable,
  screenRecording: liveSessionUnavailable,
  screenshot: liveSessionUnavailable,
  snapshot: liveSessionUnavailable,
  viewport: liveSessionUnavailable,
  focus: liveSessionUnavailable,
  gesture: liveSessionUnavailable,
  scroll: liveSessionUnavailable,
  typeText: liveSessionUnavailable,
  touch: liveSessionUnavailable,
  elementText: liveSessionUnavailable,
  back: liveSessionUnavailable,
  orientation: liveSessionUnavailable,
  fold: REVYL_FOLD_UNAVAILABLE,
  telephony: REVYL_TELEPHONY_UNAVAILABLE,
  tvRemote: liveSessionUnavailable,
  keyboard: liveSessionUnavailable,
  clipboard: liveSessionUnavailable,
  systemButton: liveSessionUnavailable,
  triggerAppEvent: liveSessionUnavailable,
  settings: liveSessionUnavailable,
  readAlert: liveSessionUnavailable,
  awaitAlert: liveSessionUnavailable,
  acceptAlert: liveSessionUnavailable,
  dismissAlert: liveSessionUnavailable,
  audioProbeCapture: liveSessionUnavailable,
  audioProbeQuery: liveSessionUnavailable,
  perf: liveSessionUnavailable,
  readiness: liveSessionUnavailable,
  shutdown: liveSessionUnavailable,
});
