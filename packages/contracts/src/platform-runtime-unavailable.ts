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

type UnavailableCellKey = keyof Omit<UnavailablePlatformRuntimeFacts, 'lifecycle'>;

/**
 * Every cell name, for iteration. Whether a cell left unclassified by its owner falls back to the
 * caller's network gap, or must be stated by the owner itself, is decided by
 * `UnavailablePlatformRuntimeFacts` alone: an optional property inherits `network`, a required one
 * is owner-stated (#1873) and always present. No second table restates that split — a misclassified
 * cell there would fail to type-check rather than silently produce a malformed fact.
 */
const UNAVAILABLE_CELLS = {
  appLog: true,
  apps: true,
  appDeployment: true,
  appState: true,
  network: true,
  screenRecording: true,
  screenshot: true,
  snapshot: true,
  viewport: true,
  focus: true,
  gesture: true,
  scroll: true,
  typeText: true,
  touch: true,
  elementText: true,
  back: true,
  home: true,
  orientation: true,
  tvRemote: true,
  keyboardStatus: true,
  keyboardDismiss: true,
  keyboardEnter: true,
  readClipboard: true,
  writeClipboard: true,
  appSwitcher: true,
  triggerAppEvent: true,
  setSetting: true,
  readAlert: true,
  awaitAlert: true,
  acceptAlert: true,
  dismissAlert: true,
  audioProbeCapture: true,
  audioProbeQuery: true,
  perf: true,
  readiness: true,
  shutdown: true,
} satisfies Record<UnavailableCellKey, true>;

/** Fills every cell name through `fn`, in the one place a cell record is assembled by key. */
function mapUnavailableCells<Value>(
  fn: (cell: UnavailableCellKey) => Value,
): Record<UnavailableCellKey, Value> {
  const result = {} as Record<UnavailableCellKey, Value>;
  for (const cell of Object.keys(UNAVAILABLE_CELLS) as UnavailableCellKey[]) {
    result[cell] = fn(cell);
  }
  return result;
}

/**
 * A complete facts value for one unavailability reason, for owners with no runtime module at all:
 * every cell, lifecycle included, reports the same reason, so a missing owner cannot leave a cell
 * unclassified by omission.
 */
export function createFullyUnavailablePlatformRuntimeFacts(
  unavailable: RuntimeOperationUnavailability,
): UnavailablePlatformRuntimeFacts {
  return Object.freeze({
    ...mapUnavailableCells(() => unavailable),
    lifecycle: applicationLifecycleOperationFacts({
      resolveOpenTarget: unavailable,
      prepareApplicationOpen: unavailable,
      openApplication: unavailable,
      applyRuntimeHints: unavailable,
      clearRuntimeHints: unavailable,
      closeApplication: unavailable,
      finalizeApplicationClose: unavailable,
      prepareAppleRunner: unavailable,
      configureProviderPortReverse: unavailable,
    }),
  });
}

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
  const frozen = freezeUnavailableFacts(unavailable);
  return Object.freeze({
    device: {
      ...deviceShape(device),
      providerMode: providerModeForOwner(owner),
    },
    operations: {
      appLogInspect: frozen.appLog,
      appLogDoctor: frozen.appLog,
      appLogStart: frozen.appLog,
      appLogReattach: frozen.appLog,
      appLogCleanup: frozen.appLog,
      listApps: frozen.apps,
      deployApp: frozen.appDeployment,
      materializeAppSource: frozen.appDeployment,
      deployMaterializedApp: frozen.appDeployment,
      sendPushNotification: frozen.appDeployment,
      appState: frozen.appState,
      networkDump: frozen.network,
      screenRecordingStart: frozen.screenRecording,
      screenRecordingReattach: frozen.screenRecording,
      screenRecordingCleanup: frozen.screenRecording,
      ...screenshotRuntimeOperationFacts({ capture: frozen.screenshot }),
      ...snapshotRuntimeOperationFacts({
        capture: frozen.snapshot,
        customActions: frozen.snapshot,
        withoutActiveApp: frozen.snapshot,
      }),
      // The preferred text reading starts unavailable for every family, on the same sentinel as
      // capture: an owner that has a native reading declares it explicitly, and one that does not
      // sends every text wait to the canonical tree.
      ...selectorObservationRuntimeOperationFacts({
        findText: frozen.snapshot,
        findSelector: frozen.snapshot,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: frozen.viewport }),
      ...focusRuntimeOperationFacts({ focus: frozen.focus }),
      ...gestureRuntimeOperationFacts({
        plan: frozen.gesture,
        directionalFling: frozen.gesture,
        multiTouch: frozen.gesture,
        targetAuthoredDrag: frozen.gesture,
        viewport: frozen.gesture,
      }),
      ...scrollRuntimeOperationFacts({ scroll: frozen.scroll }),
      ...typeTextRuntimeOperationFacts({ type: frozen.typeText }),
      ...touchRuntimeOperationFacts({
        tap: frozen.touch,
        tapRef: frozen.touch,
        longPress: frozen.touch,
        hover: frozen.touch,
        hoverRef: frozen.touch,
        fill: frozen.touch,
        fillRef: frozen.touch,
        tapElementSelector: frozen.touch,
      }),
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: frozen.elementText }),
      ...backRuntimeOperationFacts({ back: frozen.back }),
      ...homeRuntimeOperationFacts({ home: frozen.home }),
      ...orientationRuntimeOperationFacts({ orientation: frozen.orientation }),
      ...tvRemoteRuntimeOperationFacts({ tvRemote: frozen.tvRemote }),
      ...keyboardRuntimeOperationFacts({
        status: frozen.keyboardStatus,
        dismiss: frozen.keyboardDismiss,
        enter: frozen.keyboardEnter,
      }),
      ...clipboardRuntimeOperationFacts({
        read: frozen.readClipboard,
        write: frozen.writeClipboard,
      }),
      ...appSwitcherRuntimeOperationFacts({ appSwitcher: frozen.appSwitcher }),
      ...appEventRuntimeOperationFacts({ triggerAppEvent: frozen.triggerAppEvent }),
      ...settingsRuntimeOperationFacts({ setSetting: frozen.setSetting }),
      ...alertRuntimeOperationFacts({
        read: frozen.readAlert,
        wait: frozen.awaitAlert,
        accept: frozen.acceptAlert,
        dismiss: frozen.dismissAlert,
      }),
      ...audioProbeRuntimeOperationFacts({
        capture: frozen.audioProbeCapture,
        query: frozen.audioProbeQuery,
      }),
      ...perfRuntimeOperationFacts({
        frames: frozen.perf,
        memorySample: frozen.perf,
        memorySnapshot: frozen.perf,
        nativeCapture: frozen.perf,
        profileReport: frozen.perf,
      }),
      ensureReady: frozen.readiness,
      bootTarget: frozen.readiness,
      bootTargetHeadless: frozen.readiness,
      shutdownTarget: frozen.shutdown,
      ...frozen.lifecycle,
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
  return Object.freeze({
    ...mapUnavailableCells((cell) =>
      Object.freeze({ ...(unavailable[cell] ?? unavailable.network) }),
    ),
    lifecycle: applicationLifecycleOperationFacts(unavailable.lifecycle),
  });
}
