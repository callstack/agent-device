import {
  unavailableFact,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import { isIosFamily, resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import { focusRuntimeOperationFacts } from '@agent-device/contracts/focus-runtime';
import { typeTextRuntimeOperationFacts } from '@agent-device/contracts/type-text-runtime';
import { touchRuntimeOperationFacts } from '@agent-device/contracts/touch-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import { appleGestureAndScrollFacts } from './gesture-facts.ts';
import { appleNavigationFacts } from './navigation/runtime.ts';
import { appleSystemFacts } from './system/runtime.ts';

const available = Object.freeze({ available: true } as const);
const unavailable = unavailableFact('unsupported-platform-leaf');
function unsupportedAppleDeviceKind(hint: string) {
  return unavailableFact('unsupported-device-kind', hint);
}
/**
 * Focus drives touch through the Apple interactor, which exists for the simulator and physical
 * device kinds only. Parity with the retired `focus` capability bucket
 * (`{ simulator: true, device: true }`), stated as one fact instead of an admission table.
 */
const focusKindUnavailable = unavailableFact(
  'unsupported-device-kind',
  'focus is supported on Apple simulators and physical devices.',
);

const appStateUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  "Apple appstate is unavailable here: the runner reads the session app's XCUIApplication state on iOS-family simulators and physical devices only, and the Apple target answers no sessionless foreground probe. The per-command answer is the targetActivation disclosure, which a capture carries when its command had to re-activate the session app (#2682).",
);

const elementTextLeafUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'watchOS has no XCUITest-driveable UI, so element text comes from the captured tree only.',
);

const elementTextKindUnavailable = unavailableFact('unsupported-device-kind');

const snapshotKindUnavailable = unsupportedAppleDeviceKind(
  'snapshot is supported only for Apple simulators and devices.',
);

const snapshotCustomActionsUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'Re-run without --actions, or target an iOS simulator.',
);

const snapshotActiveAppRequired = unavailableFact(
  'owner-capability-missing',
  'Open the app under test before capturing its snapshot.',
);

/**
 * A live runner reads the session app's `XCUIApplication.state` on the kinds it drives; the read
 * never starts one (see `bindAppleAppStateRuntime`). That is a fact about the session app, never a
 * guess about the foreground (#2682): after `home` the app reports a background state, and which
 * app took the screen stays nobody's to tell.
 */
function appleAppStateFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isIosFamily(device) || device.appleOs === 'watchos') return appStateUnavailable;
  return device.kind === 'simulator' || device.kind === 'device' ? available : appStateUnavailable;
}

function appleFocusFact(device: DeviceInfo): RuntimeOperationFact {
  return device.kind === 'simulator' || device.kind === 'device' ? available : focusKindUnavailable;
}

/**
 * The live point read is the XCUITest runner's `readText` for app sessions and the macOS helper
 * for desktop/menubar surfaces. Both need a driveable Apple UI, so watchOS and the non
 * simulator/device kinds have no read at all.
 */
function appleElementTextFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return elementTextLeafUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : elementTextKindUnavailable;
}

function appleSnapshotFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return snapshotKindUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : snapshotKindUnavailable;
}

function appleSnapshotFacts(device: DeviceInfo) {
  const capture = appleSnapshotFact(device);
  return snapshotRuntimeOperationFacts({
    capture,
    customActions:
      capture.available && isIosFamily(device) && device.kind === 'simulator'
        ? available
        : snapshotCustomActionsUnavailable,
    withoutActiveApp: isIosFamily(device) ? snapshotActiveAppRequired : capture,
  });
}
/** Apple interaction support is independent of who owns the simulator or transports runner commands. */
export function appleRunnerInteractionFacts(device: DeviceInfo) {
  return {
    appState: appleAppStateFact(device),
    pressReadiness: ['ios', 'ipados'].includes(resolveDeviceAppleOs(device))
      ? appleFocusFact(device)
      : unavailable,
    prepareAppleRunner: applePrepareAppleRunnerFact(device),
    ...appleSnapshotFacts(device),
    ...selectorObservationRuntimeOperationFacts({
      findText: appleSnapshotFact(device),
      querySelector: isIosFamily(device) ? appleFocusFact(device) : unavailable,
    }),
    ...focusRuntimeOperationFacts({ focus: appleFocusFact(device) }),
    ...appleGestureAndScrollFacts(device),
    ...typeTextRuntimeOperationFacts({ type: appleFocusFact(device) }),
    ...touchRuntimeOperationFacts({
      unsupported: unavailable,
      tap: appleFocusFact(device),
      longPress: appleFocusFact(device),
      fill: appleFocusFact(device),
      ...(isIosFamily(device) ? { tapElementSelector: appleFocusFact(device) } : {}),
    }),
    ...elementTextRuntimeOperationFacts({ readTextAtPoint: appleElementTextFact(device) }),
    ...appleNavigationFacts(device),
    ...appleSystemFacts(device),
  };
}

const watchPrepareUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'watchOS runner preparation is not supported because XCUITest cannot drive watchOS UI.',
);

const applePrepareKindUnavailable = unsupportedAppleDeviceKind(
  'prepare is supported only for Apple simulators and devices.',
);

export function applePrepareAppleRunnerFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return watchPrepareUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : applePrepareKindUnavailable;
}
