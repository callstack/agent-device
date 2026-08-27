import { APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS } from '@agent-device/contracts/apple-multitouch-support';
import {
  PHYSICAL_IOS_MULTI_TOUCH_UNSUPPORTED_HINT,
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
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
export function appleGestureAndScrollFacts(device: DeviceInfo) {
  return {
    ...gestureRuntimeOperationFacts({
      plan: appleGesturePlanFact(device),
      directionalFling: appleGesturePlanFact(device),
      multiTouch: appleMultiTouchGestureFact(device),
      targetAuthoredDrag: appleTargetAuthoredDragFact(device),
      viewport: appleGestureViewportFact(device),
    }),
    ...scrollRuntimeOperationFacts({ scroll: appleScrollFact(device) }),
  };
}

function appleGesturePlanFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.appleOs === 'watchos' || device.appleOs === 'visionos') return gestureLeafUnavailable;
  return appleTouchKind(device) ? available : gestureKindUnavailable;
}

function appleMultiTouchGestureFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.appleOs === 'watchos') return gestureLeafUnavailable;
  if (!appleTouchKind(device)) return gestureKindUnavailable;
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

function appleTargetAuthoredDragFact(device: DeviceInfo): RuntimeOperationFact {
  if (!appleTouchKind(device)) return gestureKindUnavailable;
  const supported =
    device.appleOs === undefined
      ? device.target !== 'desktop' && device.target !== 'tv'
      : device.appleOs === 'ios' || device.appleOs === 'ipados';
  return supported ? available : targetAuthoredDragUnavailable;
}

function appleGestureViewportFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.appleOs === 'watchos') return gestureLeafUnavailable;
  return appleTouchKind(device) ? available : gestureKindUnavailable;
}

function appleScrollFact(device: DeviceInfo): RuntimeOperationFact {
  return appleTouchKind(device) ? available : scrollKindUnavailable;
}

function appleTouchKind(device: DeviceInfo): boolean {
  return device.kind === 'simulator' || device.kind === 'device';
}
