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
} from './platform-runtime.ts';
import { screenshotRuntimeOperationFacts } from './screenshot-runtime.ts';
import { snapshotRuntimeOperationFacts } from './snapshot-runtime.ts';
import { selectorObservationRuntimeOperationFacts } from './selector-observation-runtime.ts';
import { viewportRuntimeOperationFacts } from './viewport-runtime.ts';
import { focusRuntimeOperationFacts } from './focus-runtime.ts';
import { typeTextRuntimeOperationFacts } from './type-text-runtime.ts';
import { elementTextRuntimeOperationFacts } from './element-text-runtime.ts';
import { backRuntimeOperationFacts } from './back-runtime.ts';
import { homeRuntimeOperationFacts } from './home-runtime.ts';
import { orientationRuntimeOperationFacts } from './orientation-runtime.ts';
import { tvRemoteRuntimeOperationFacts } from './tv-remote-runtime.ts';
import { keyboardRuntimeOperationFacts } from './keyboard-runtime.ts';
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
    readiness,
    shutdown,
    lifecycle,
  } = freezeUnavailableFacts(unavailable);
  return Object.freeze({
    device: {
      ...deviceShape(device),
      providerMode: owner.kind === 'local-family' ? 'local' : 'provider-runtime',
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
      ensureReady: readiness,
      bootTarget: readiness,
      bootTargetHeadless: readiness,
      shutdownTarget: shutdown,
      ...lifecycle,
    },
  });
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
    lifecycle: applicationLifecycleOperationFacts(unavailable.lifecycle),
  });
}
