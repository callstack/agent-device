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

/**
 * A runtime-contract helper for provider ownership gaps. It never assigns lifecycle semantics:
 * the selected package/provider must classify every lifecycle operation for its exact cell.
 *
 * A family is one cell where all of its operations share one reason, and one cell per operation
 * only where the reasons genuinely differ per operation.
 *
 * Every operation is stated here by name, never through its family's facts builder: each owner
 * builds on this value, so a family this module evaluated would be one every owner evaluates,
 * whether or not it implements that family. `RuntimeFacts` refuses a value that omits an operation.
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
  orientation: RuntimeOperationUnavailability;
  fold: RuntimeOperationUnavailability;
  telephony: RuntimeOperationUnavailability;
  tvRemote: RuntimeOperationUnavailability;
  keyboard: RuntimeOperationUnavailability;
  clipboard: RuntimeOperationUnavailability;
  systemButton: RuntimeOperationUnavailability;
  triggerAppEvent: RuntimeOperationUnavailability;
  /** Refuses every setting, read and write alike. */
  settings: RuntimeOperationUnavailability;
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
  orientation: true,
  fold: true,
  telephony: true,
  tvRemote: true,
  keyboard: true,
  clipboard: true,
  systemButton: true,
  triggerAppEvent: true,
  settings: true,
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
      uninstallApp: frozen.appDeployment,
      appState: frozen.appState,
      networkDump: frozen.network,
      screenRecordingStart: frozen.screenRecording,
      screenRecordingReattach: frozen.screenRecording,
      screenRecordingCleanup: frozen.screenRecording,
      captureScreenshot: frozen.screenshot,
      captureSnapshot: frozen.snapshot,
      captureSnapshotWithCustomActions: frozen.snapshot,
      captureSnapshotWithoutActiveApp: frozen.snapshot,
      // The preferred text reading starts unavailable for every family, on the same sentinel as
      // capture: an owner that has a native reading declares it explicitly, and one that does not
      // sends every text wait to the canonical tree. The live selector read starts unavailable for
      // the same reason: an owner without it refuses on its bulk-tree verdict unchanged.
      findText: frozen.snapshot,
      querySelector: frozen.snapshot,
      setViewport: frozen.viewport,
      focusPoint: frozen.focus,
      performGesturePlan: frozen.gesture,
      performDirectionalFlingPlan: frozen.gesture,
      performMultiTouchGesturePlan: frozen.gesture,
      performTargetAuthoredDrag: frozen.gesture,
      gestureViewport: frozen.gesture,
      scrollDirection: frozen.scroll,
      typeText: frozen.typeText,
      tapPoint: frozen.touch,
      tapRef: frozen.touch,
      longPressPoint: frozen.touch,
      hoverPoint: frozen.touch,
      hoverRef: frozen.touch,
      fillPoint: frozen.touch,
      fillRef: frozen.touch,
      tapElementSelector: frozen.touch,
      readTextAtPoint: frozen.elementText,
      back: frozen.back,
      setOrientation: frozen.orientation,
      unlockOrientation: frozen.orientation,
      setFoldPose: frozen.fold,
      sendTelephonyEvent: frozen.telephony,
      tvRemote: frozen.tvRemote,
      keyboardStatus: frozen.keyboard,
      keyboardDismiss: frozen.keyboard,
      keyboardEnter: frozen.keyboard,
      readClipboard: frozen.clipboard,
      writeClipboard: frozen.clipboard,
      home: frozen.systemButton,
      appSwitcher: frozen.systemButton,
      actionButton: frozen.systemButton,
      shake: frozen.systemButton,
      volumeUp: frozen.systemButton,
      volumeDown: frozen.systemButton,
      power: frozen.systemButton,
      mute: frozen.systemButton,
      sleep: frozen.systemButton,
      wake: frozen.systemButton,
      mediaPlayPause: frozen.systemButton,
      mediaNext: frozen.systemButton,
      mediaPrevious: frozen.systemButton,
      mediaRewind: frozen.systemButton,
      mediaFastForward: frozen.systemButton,
      triggerAppEvent: frozen.triggerAppEvent,
      setSetting: frozen.settings,
      readSetting: frozen.settings,
      readAlert: frozen.readAlert,
      awaitAlert: frozen.awaitAlert,
      acceptAlert: frozen.acceptAlert,
      dismissAlert: frozen.dismissAlert,
      audioProbeStart: frozen.audioProbeCapture,
      audioProbeReattach: frozen.audioProbeCapture,
      audioProbeCleanup: frozen.audioProbeCapture,
      audioProbeQuery: frozen.audioProbeQuery,
      perfFrames: frozen.perf,
      perfMemorySample: frozen.perf,
      perfMemorySnapshot: frozen.perf,
      perfNativeCaptureStart: frozen.perf,
      perfNativeCaptureReattach: frozen.perf,
      perfNativeCaptureCleanup: frozen.perf,
      perfProfileReport: frozen.perf,
      ensureReady: frozen.readiness,
      bootTarget: frozen.readiness,
      bootTargetHeadless: frozen.readiness,
      shutdownTarget: frozen.shutdown,
      ...frozen.lifecycle,
    },
  });
}

function providerModeForOwner(owner: RuntimeOwnerRef): RuntimeProviderMode {
  switch (owner.kind) {
    case 'local-family':
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
