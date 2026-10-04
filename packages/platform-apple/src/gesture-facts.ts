import { APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS } from './multitouch-support.ts';
import {
  PHYSICAL_IOS_MULTI_TOUCH_UNSUPPORTED_HINT,
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import type {
  RuntimeOperationFact,
  RuntimeOperationUnavailability,
} from '@agent-device/contracts/platform-runtime';
import { scrollRuntimeOperationFacts } from '@agent-device/contracts/scroll-runtime';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);
const gestureLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const gestureKindUnavailable = unsupportedAppleDeviceKind(
  'Gestures are supported only for Apple simulators and devices.',
);
const physicalIosMultiTouchUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: PHYSICAL_IOS_MULTI_TOUCH_UNSUPPORTED_HINT,
} as const);
const targetAuthoredDragUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} as const);
const scrollKindUnavailable = unsupportedAppleDeviceKind(
  'scroll is supported only for Apple simulators and devices.',
);

function unsupportedAppleDeviceKind(hint: string) {
  return Object.freeze({ available: false, reason: 'unsupported-device-kind', hint } as const);
}

/** The gesture and scroll cells one Apple leaf declares, ready to spread into its fact catalog. */
export function appleGestureAndScrollFacts(device: DeviceInfo, watchHidAvailable = false) {
  return {
    ...gestureRuntimeOperationFacts({
      unsupported: appleGestureFamilyUnavailable(device, watchHidAvailable),
      plan: appleGesturePlanFact(device, watchHidAvailable),
      directionalFling: appleGesturePlanFact(device, watchHidAvailable),
      multiTouch: appleMultiTouchGestureFact(device, watchHidAvailable),
      targetAuthoredDrag: appleTargetAuthoredDragFact(device, watchHidAvailable),
      viewport: appleGestureViewportFact(device, watchHidAvailable),
    }),
    ...scrollRuntimeOperationFacts({ scroll: appleScrollFact(device, watchHidAvailable) }),
  };
}

/** The reason this leaf refuses gestures it does not name, before any tier is consulted. */
function appleGestureFamilyUnavailable(
  device: DeviceInfo,
  watchHidAvailable: boolean,
): RuntimeOperationUnavailability {
  if (device.appleOs === 'watchos' && !watchHidAvailable) return gestureLeafUnavailable;
  return device.appleOs === 'visionos' ? gestureLeafUnavailable : gestureKindUnavailable;
}

function appleGesturePlanFact(
  device: DeviceInfo,
  watchHidAvailable: boolean,
): RuntimeOperationFact {
  if (device.appleOs === 'visionos') return gestureLeafUnavailable;
  return appleTouchKind(device, watchHidAvailable) ? available : gestureKindUnavailable;
}

function appleMultiTouchGestureFact(
  device: DeviceInfo,
  watchHidAvailable: boolean,
): RuntimeOperationFact {
  if (device.appleOs === 'watchos') return gestureLeafUnavailable;
  if (!appleTouchKind(device, watchHidAvailable)) return gestureKindUnavailable;
  const appleOs = resolveDeviceAppleOs(device);
  if (appleOs !== 'ios' && appleOs !== 'ipados') {
    const hint = APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS[appleOs];
    return Object.freeze({
      available: false,
      reason: 'unsupported-platform-leaf',
      ...(hint === undefined ? {} : { hint }),
    } as const);
  }
  return device.kind === 'simulator' ? available : physicalIosMultiTouchUnavailable;
}

function appleTargetAuthoredDragFact(
  device: DeviceInfo,
  watchHidAvailable: boolean,
): RuntimeOperationFact {
  if (!appleTouchKind(device, watchHidAvailable)) return gestureKindUnavailable;
  const supported =
    device.appleOs === undefined
      ? device.target !== 'desktop' && device.target !== 'tv'
      : device.appleOs === 'ios' || device.appleOs === 'ipados';
  return supported ? available : targetAuthoredDragUnavailable;
}

function appleGestureViewportFact(
  device: DeviceInfo,
  watchHidAvailable: boolean,
): RuntimeOperationFact {
  return appleTouchKind(device, watchHidAvailable) ? available : gestureKindUnavailable;
}

function appleScrollFact(device: DeviceInfo, watchHidAvailable: boolean): RuntimeOperationFact {
  return appleTouchKind(device, watchHidAvailable) ? available : scrollKindUnavailable;
}

function appleTouchKind(device: DeviceInfo, watchHidAvailable = false): boolean {
  if (device.appleOs === 'watchos') {
    return device.kind === 'simulator' && !device.simulatorSetPath && watchHidAvailable;
  }
  return device.kind === 'simulator' || device.kind === 'device';
}
