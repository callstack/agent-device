import { APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS } from '@agent-device/contracts/apple-multitouch-support';
import {
  PHYSICAL_IOS_MULTI_TOUCH_UNSUPPORTED_HINT,
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { scrollRuntimeOperationFacts } from '@agent-device/contracts/scroll-runtime';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';

/**
 * The Apple owner's gesture-family cell table (R52/R53).
 *
 * This is admission the daemon used to own: `requireGestureSupported` decided Apple's gesture
 * tiers from inside `core/capabilities.ts`. Every refusal below reproduces the exact cell — and
 * the exact hint — that function produced, which is why the wording constants are imported rather
 * than restated. `runtime.ts` composes these facts; it does not decide them.
 */
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

/**
 * One-contact gesture execution. The retired admission refused watchOS with every other
 * `platform === 'web'` case and refused visionOS just after the multi-touch branch, both by
 * reading `device.appleOs` RAW — an Apple device that declares no OS was admitted, so this reads
 * it raw too rather than resolving a default that would newly refuse.
 */
function appleGesturePlanFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.appleOs === 'watchos' || device.appleOs === 'visionos') return gestureLeafUnavailable;
  return appleTouchKind(device) ? available : gestureKindUnavailable;
}

/**
 * Two-contact synthesis, which on Apple is the iOS-simulator-only XCTest two-finger model. watchOS
 * is refused with no hint because the retired admission caught it in its first branch, before the
 * multi-touch policy that carries the per-OS hints ever ran.
 */
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

/** Target-authored drag needs source hold, timed movement, and destination hold preserved. */
function appleTargetAuthoredDragFact(device: DeviceInfo): RuntimeOperationFact {
  if (!appleTouchKind(device)) return gestureKindUnavailable;
  const supported =
    device.appleOs === undefined
      ? device.target !== 'desktop' && device.target !== 'tv'
      : device.appleOs === 'ios' || device.appleOs === 'ipados';
  return supported ? available : targetAuthoredDragUnavailable;
}

/** The runner reads the frame for every Apple leaf that has one; watchOS has no runner at all. */
function appleGestureViewportFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.appleOs === 'watchos') return gestureLeafUnavailable;
  return appleTouchKind(device) ? available : gestureKindUnavailable;
}

/**
 * `scroll` had no admission beyond its capability bucket — no plugin closure, no gesture policy —
 * so its cell is the bucket verbatim, watchOS included. A watchOS scroll still fails where it
 * fails today: when the Apple interactor refuses to construct, not at admission.
 */
function appleScrollFact(device: DeviceInfo): RuntimeOperationFact {
  return appleTouchKind(device) ? available : scrollKindUnavailable;
}

/** The two kinds the Apple capability bucket ever admitted. */
function appleTouchKind(device: DeviceInfo): boolean {
  return device.kind === 'simulator' || device.kind === 'device';
}
