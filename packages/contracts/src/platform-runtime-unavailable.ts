import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import {
  applicationLifecycleOperationFacts,
  type ApplicationLifecycleOperationFacts,
} from './application-lifecycle-runtime.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';
import type {
  DeviceBinding,
  RuntimeFacts,
  RuntimeOperationUnavailability,
  RuntimeOwnerRef,
  RuntimeProviderMode,
} from './platform-runtime.ts';
import { screenshotRuntimeOperationFacts } from './screenshot-runtime.ts';
import { snapshotRuntimeOperationFacts } from './snapshot-runtime.ts';
import { selectorObservationRuntimeOperationFacts } from './selector-observation-runtime.ts';
import { viewportRuntimeOperationFacts } from './viewport-runtime.ts';
import { focusRuntimeOperationFacts } from './focus-runtime.ts';
import { gestureRuntimeOperationFacts } from './gesture-runtime.ts';
import { scrollRuntimeOperationFacts } from './scroll-runtime.ts';
import { typeTextRuntimeOperationFacts } from './type-text-runtime.ts';
import { elementTextRuntimeOperationFacts } from './element-text-runtime.ts';
import { backRuntimeOperationFacts } from './back-runtime.ts';
import { homeRuntimeOperationFacts } from './home-runtime.ts';
import { orientationRuntimeOperationFacts } from './orientation-runtime.ts';
import { tvRemoteRuntimeOperationFacts } from './tv-remote-runtime.ts';
import { keyboardRuntimeOperationFacts } from './keyboard-runtime.ts';
import { clipboardRuntimeOperationFacts } from './clipboard-runtime.ts';
import { appSwitcherRuntimeOperationFacts } from './app-switcher-runtime.ts';
import { appEventRuntimeOperationFacts } from './app-event-runtime.ts';
import { settingsRuntimeOperationFacts } from './settings-runtime.ts';
import { alertRuntimeOperationFacts } from './alert-runtime.ts';
import { audioProbeRuntimeOperationFacts } from './audio-probe-runtime.ts';
import { perfRuntimeOperationFacts } from './perf-runtime.ts';
import { touchRuntimeOperationFacts } from './touch-runtime.ts';

/**
 * A runtime-contract helper for provider ownership gaps. It never assigns lifecycle semantics:
 * the selected package/provider must classify every lifecycle operation for its exact cell.
 */
export type UnavailablePlatformRuntimeFacts = Readonly<{
  appLog: RuntimeOperationUnavailability;
  apps?: RuntimeOperationUnavailability;
  appDeployment?: RuntimeOperationUnavailability;
  appState?: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
  screenRecording?: RuntimeOperationUnavailability;
  screenshot: RuntimeOperationUnavailability;
  snapshot?: RuntimeOperationUnavailability;
  viewport: RuntimeOperationUnavailability;
  focus: RuntimeOperationUnavailability;
  gesture: RuntimeOperationUnavailability;
  scroll: RuntimeOperationUnavailability;
  typeText: RuntimeOperationUnavailability;
  touch: RuntimeOperationUnavailability;
  elementText: RuntimeOperationUnavailability;
  back: RuntimeOperationUnavailability;
  home: RuntimeOperationUnavailability;
  orientation: RuntimeOperationUnavailability;
  tvRemote: RuntimeOperationUnavailability;
  keyboardStatus: RuntimeOperationUnavailability;
  keyboardDismiss: RuntimeOperationUnavailability;
  keyboardEnter: RuntimeOperationUnavailability;
  readClipboard: RuntimeOperationUnavailability;
  writeClipboard: RuntimeOperationUnavailability;
  appSwitcher: RuntimeOperationUnavailability;
  triggerAppEvent: RuntimeOperationUnavailability;
  setSetting: RuntimeOperationUnavailability;
  readAlert: RuntimeOperationUnavailability;
  awaitAlert: RuntimeOperationUnavailability;
  acceptAlert: RuntimeOperationUnavailability;
  dismissAlert: RuntimeOperationUnavailability;
  audioProbeCapture: RuntimeOperationUnavailability;
  audioProbeQuery: RuntimeOperationUnavailability;
  perf?: RuntimeOperationUnavailability;
  readiness?: RuntimeOperationUnavailability;
  shutdown?: RuntimeOperationUnavailability;
  lifecycle: ApplicationLifecycleOperationFacts;
}>;

/**
 * The same cells with every optional one resolved. Derived from the input type rather than
 * restated, so a new cell cannot be added to one and forgotten in the other.
 */
type FrozenUnavailablePlatformRuntimeFacts = Readonly<
  Required<Omit<UnavailablePlatformRuntimeFacts, 'lifecycle'>> &
    Readonly<{ lifecycle: ApplicationLifecycleOperationFacts }>
>;

export function createUnavailablePlatformRuntimeBinding(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): DeviceBinding<PlatformRuntimeOperations> {
  return Object.freeze({
    device,
    owner,
    facts: createUnavailablePlatformRuntimeFacts(device, owner, unavailable),
    operations: Object.freeze({}),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

export function createUnavailablePlatformRuntimeFacts(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): RuntimeFacts<PlatformRuntimeOperations> {
  const {
    appLog,
    apps,
    appDeployment,
    appState,
    network,
    screenRecording,
    screenshot,
    snapshot,
    viewport,
    focus,
    gesture,
    scroll,
    typeText,
    touch,
    elementText,
    back,
    home,
    orientation,
    tvRemote,
    keyboardStatus,
    keyboardDismiss,
    keyboardEnter,
    readClipboard,
    writeClipboard,
    appSwitcher,
    triggerAppEvent,
    setSetting,
    readAlert,
    awaitAlert,
    acceptAlert,
    dismissAlert,
    audioProbeCapture,
    audioProbeQuery,
    perf,
    readiness,
    shutdown,
    lifecycle,
  } = freezeUnavailableFacts(unavailable);
  return Object.freeze({
    device: {
      ...deviceShape(device),
      providerMode: providerModeForOwner(owner),
    },
    operations: {
      appLogInspect: appLog,
      appLogDoctor: appLog,
      appLogStart: appLog,
      appLogReattach: appLog,
      appLogCleanup: appLog,
      listApps: apps,
      deployApp: appDeployment,
      materializeAppSource: appDeployment,
      deployMaterializedApp: appDeployment,
      sendPushNotification: appDeployment,
      appState,
      networkDump: network,
      screenRecordingStart: screenRecording,
      screenRecordingReattach: screenRecording,
      screenRecordingCleanup: screenRecording,
      ...screenshotRuntimeOperationFacts({ capture: screenshot }),
      ...snapshotRuntimeOperationFacts({
        capture: snapshot,
        customActions: snapshot,
        withoutActiveApp: snapshot,
      }),
      // The preferred text reading starts unavailable for every family, on the same sentinel as
      // capture: an owner that has a native reading declares it explicitly, and one that does not
      // sends every text wait to the canonical tree.
      ...selectorObservationRuntimeOperationFacts({
        findText: snapshot,
        findSelector: snapshot,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: viewport }),
      ...focusRuntimeOperationFacts({ focus }),
      ...gestureRuntimeOperationFacts({
        plan: gesture,
        directionalFling: gesture,
        multiTouch: gesture,
        targetAuthoredDrag: gesture,
        viewport: gesture,
      }),
      ...scrollRuntimeOperationFacts({ scroll }),
      ...typeTextRuntimeOperationFacts({ type: typeText }),
      ...touchRuntimeOperationFacts({
        tap: touch,
        tapRef: touch,
        longPress: touch,
        hover: touch,
        hoverRef: touch,
        fill: touch,
        fillRef: touch,
        tapElementSelector: touch,
      }),
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementText }),
      ...backRuntimeOperationFacts({ back }),
      ...homeRuntimeOperationFacts({ home }),
      ...orientationRuntimeOperationFacts({ orientation }),
      ...tvRemoteRuntimeOperationFacts({ tvRemote }),
      ...keyboardRuntimeOperationFacts({
        status: keyboardStatus,
        dismiss: keyboardDismiss,
        enter: keyboardEnter,
      }),
      ...clipboardRuntimeOperationFacts({ read: readClipboard, write: writeClipboard }),
      ...appSwitcherRuntimeOperationFacts({ appSwitcher }),
      ...appEventRuntimeOperationFacts({ triggerAppEvent }),
      ...settingsRuntimeOperationFacts({ setSetting }),
      ...alertRuntimeOperationFacts({
        read: readAlert,
        wait: awaitAlert,
        accept: acceptAlert,
        dismiss: dismissAlert,
      }),
      ...audioProbeRuntimeOperationFacts({
        capture: audioProbeCapture,
        query: audioProbeQuery,
      }),
      ...perfRuntimeOperationFacts({
        frames: perf,
        memorySample: perf,
        memorySnapshot: perf,
        nativeCapture: perf,
        profileReport: perf,
      }),
      ensureReady: readiness,
      bootTarget: readiness,
      bootTargetHeadless: readiness,
      shutdownTarget: shutdown,
      ...lifecycle,
    },
  });
}

/** A managed local owner executes through its local family, so it reports the local mode. */
function providerModeForOwner(owner: RuntimeOwnerRef): RuntimeProviderMode {
  switch (owner.kind) {
    case 'local-family':
    case 'managed-local':
      return 'local';
    case 'provider-runtime':
      return 'provider-runtime';
  }
}

function freezeUnavailableFacts(
  unavailable: UnavailablePlatformRuntimeFacts,
): FrozenUnavailablePlatformRuntimeFacts {
  // Every optional cell falls back to the caller's network gap: an owner that did not classify a
  // family has, by construction, the same reason its transport does.
  const orNetwork = (fact: RuntimeOperationUnavailability | undefined) =>
    Object.freeze({ ...(fact ?? unavailable.network) });
  return Object.freeze({
    appLog: Object.freeze({ ...unavailable.appLog }),
    apps: orNetwork(unavailable.apps),
    appDeployment: orNetwork(unavailable.appDeployment),
    appState: orNetwork(unavailable.appState),
    network: Object.freeze({ ...unavailable.network }),
    screenRecording: orNetwork(unavailable.screenRecording),
    // Capture cells are stated by their owner, never inherited from the transport gap (#1873).
    screenshot: Object.freeze({ ...unavailable.screenshot }),
    snapshot: orNetwork(unavailable.snapshot),
    viewport: Object.freeze({ ...unavailable.viewport }),
    // Interaction cells are stated by their owner: a family that can drive touch says so for its
    // exact kinds, and one that cannot must say why rather than inherit a transport gap.
    focus: Object.freeze({ ...unavailable.focus }),
    gesture: Object.freeze({ ...unavailable.gesture }),
    scroll: Object.freeze({ ...unavailable.scroll }),
    typeText: Object.freeze({ ...unavailable.typeText }),
    touch: Object.freeze({ ...unavailable.touch }),
    readiness: orNetwork(unavailable.readiness),
    shutdown: orNetwork(unavailable.shutdown),
    elementText: Object.freeze({ ...unavailable.elementText }),
    // Navigation and keyboard cells are stated by their owner too: each differs by family
    // (harmonyos drives back/home but not orientation/tvRemote; android alone answers a keyboard
    // status read), so none of them may inherit a sibling's gap.
    back: Object.freeze({ ...unavailable.back }),
    home: Object.freeze({ ...unavailable.home }),
    orientation: Object.freeze({ ...unavailable.orientation }),
    tvRemote: Object.freeze({ ...unavailable.tvRemote }),
    keyboardStatus: Object.freeze({ ...unavailable.keyboardStatus }),
    keyboardDismiss: Object.freeze({ ...unavailable.keyboardDismiss }),
    keyboardEnter: Object.freeze({ ...unavailable.keyboardEnter }),
    // Clipboard cells are stated by their owner for the same reason: the surface differs by leaf
    // and kind (an Apple simulator has one, a physical non-macOS Apple device does not), and read
    // and write can diverge on a provider whose extension exposes only one half.
    readClipboard: Object.freeze({ ...unavailable.readClipboard }),
    writeClipboard: Object.freeze({ ...unavailable.writeClipboard }),
    // The app switcher is the springboard surface `home` drives, and differs by owner the same
    // way: an owner states it for its exact leaf rather than inheriting a sibling's gap.
    appSwitcher: Object.freeze({ ...unavailable.appSwitcher }),
    // App-event delivery opens a URL on the device, which is not something a transport gap can
    // speak for: each owner states whether it can open one at all.
    triggerAppEvent: Object.freeze({ ...unavailable.triggerAppEvent }),
    // Device settings differ by leaf and kind the way the pasteboard does, and a provider can
    // own a device without exposing any settings API at all, so each owner states its own cell.
    setSetting: Object.freeze({ ...unavailable.setSetting }),
    readAlert: Object.freeze({ ...unavailable.readAlert }),
    awaitAlert: Object.freeze({ ...unavailable.awaitAlert }),
    acceptAlert: Object.freeze({ ...unavailable.acceptAlert }),
    dismissAlert: Object.freeze({ ...unavailable.dismissAlert }),
    // Audio cells are stated by their owner (#1873): host capture and the page probe live on
    // different families entirely, so neither may inherit a transport gap.
    audioProbeCapture: Object.freeze({ ...unavailable.audioProbeCapture }),
    audioProbeQuery: Object.freeze({ ...unavailable.audioProbeQuery }),
    // Perf starts native tools and may create a durable capture. Every exact owner states the
    // gap rather than inheriting a transport failure that could imply local-tool fallthrough.
    perf: orNetwork(unavailable.perf),
    lifecycle: applicationLifecycleOperationFacts(unavailable.lifecycle),
  });
}
