import { APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS } from './multitouch-support.ts';
import { TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT } from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import type {
  RuntimeOperationFact,
  RuntimeOperationUnavailability,
} from '@agent-device/contracts/platform-runtime';
import { scrollRuntimeOperationFacts } from '@agent-device/contracts/scroll-runtime';
import {
  isHandheldAppleDevice,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);
const gestureLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const gestureKindUnavailable = unsupportedAppleDeviceKind(
  'Gestures are supported only for Apple simulators and devices.',
);
const targetAuthoredDragUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} as const);
const scrollKindUnavailable = unsupportedAppleDeviceKind(
  'scroll is supported only for Apple simulators and devices.',
);
const touchScrollLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'scroll refresh needs a touch scroll surface: iOS or iPadOS simulators and devices.',
} as const);

function unsupportedAppleDeviceKind(hint: string) {
  return Object.freeze({ available: false, reason: 'unsupported-device-kind', hint } as const);
}

/** The gesture and scroll cells one Apple leaf declares, ready to spread into its fact catalog. */
export function appleGestureAndScrollFacts(device: DeviceInfo) {
  return {
    ...gestureRuntimeOperationFacts({
      unsupported: appleGestureFamilyUnavailable(device),
      plan: appleGesturePlanFact(device),
      directionalFling: appleGesturePlanFact(device),
      multiTouch: appleMultiTouchGestureFact(device),
      targetAuthoredDrag: appleTargetAuthoredDragFact(device),
      viewport: appleGestureViewportFact(device),
    }),
    ...scrollRuntimeOperationFacts({
      scroll: appleScrollFact(device),
      touchScrollSurface: appleTouchScrollFact(device),
    }),
  };
}

/** The reason this leaf refuses gestures it does not name, before any tier is consulted. */
function appleGestureFamilyUnavailable(device: DeviceInfo): RuntimeOperationUnavailability {
  return device.appleOs === 'visionos' ? gestureLeafUnavailable : gestureKindUnavailable;
}

function appleGesturePlanFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.appleOs === 'visionos') return gestureLeafUnavailable;
  return appleTouchKind(device) ? available : gestureKindUnavailable;
}

function appleMultiTouchGestureFact(device: DeviceInfo): RuntimeOperationFact {
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
  return available;
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
  return appleTouchKind(device) ? available : gestureKindUnavailable;
}

function appleScrollFact(device: DeviceInfo): RuntimeOperationFact {
  return appleTouchKind(device) ? available : scrollKindUnavailable;
}

/**
 * Pull-to-refresh is a touch gesture, so it is declared exactly on the handheld Apple devices —
 * iOS and iPadOS, where it is a primary gesture — and refused on watchOS, tvOS, visionOS, and the
 * macOS desktop, whose scroll surfaces are not finger-pulled.
 */
function appleTouchScrollFact(device: DeviceInfo): RuntimeOperationFact {
  return isHandheldAppleDevice(device) ? available : touchScrollLeafUnavailable;
}

function appleTouchKind(device: DeviceInfo): boolean {
  return device.kind === 'simulator' || device.kind === 'device';
}
