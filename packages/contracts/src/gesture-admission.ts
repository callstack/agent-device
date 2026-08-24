import {
  isApplePlatform,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { APPLE_OS_DISPLAY_NAMES } from './apple-os-display-names.ts';
import type { GestureCommandInput } from './gesture-plan-types.ts';
import type { GestureRuntimeTier } from './gesture-tier.ts';

/** The hint an owner states when it cannot preserve a target-authored drag's timing. */
export const TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT =
  'Target-authored drag requires an adapter that preserves source hold, timed movement, and destination hold; it is supported on Android touch devices and iOS/iPadOS.';

/** The hint the Android owner states for a TV target, which has no touch input at all. */
export const ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT =
  'Android TV has no touch input — this gesture is supported on Android phones, tablets, and the iOS simulator only.';

/** The hint the Apple owner states for a physical iOS/iPadOS device. */
export const PHYSICAL_IOS_MULTI_TOUCH_UNSUPPORTED_HINT =
  'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.';

/**
 * How a refused cell names itself, reproducing every subject the retired admission produced.
 *
 * Four owner-specific subjects, then the plain platform name. The special cases resolve the
 * Apple OS the way `assertAppleMultiTouchSupported` does; the default reads `appleOs` raw, the way
 * the retired `gesturePlatformMessage` did — an Apple device with no declared OS therefore still
 * reports `apple`, exactly as before.
 */
function gestureRefusalSubject(device: DeviceInfo, tier: GestureRuntimeTier): string {
  const owned =
    tier === 'multi-touch'
      ? multiTouchRefusalSubject(device)
      : tier === 'directional-fling' && device.platform === 'linux'
        ? 'Linux'
        : undefined;
  return owned ?? device.appleOs ?? device.platform;
}

/**
 * The three owner-specific subjects two-contact synthesis produced, or `undefined` where the
 * retired admission fell through to the plain platform name.
 */
function multiTouchRefusalSubject(device: DeviceInfo): string | undefined {
  if (device.platform === 'android') return device.target === 'tv' ? 'Android TV' : undefined;
  if (!isApplePlatform(device.platform)) return undefined;
  const appleOs = resolveDeviceAppleOs(device);
  if (appleOs === 'ios' || appleOs === 'ipados') return 'physical iOS devices';
  if (appleOs === 'macos' || appleOs === 'tvos' || appleOs === 'visionos') {
    return APPLE_OS_DISPLAY_NAMES[appleOs];
  }
  return undefined;
}

/**
 * The refusal one unavailable gesture cell reports. `gesture fling` on Linux keeps its bare intent
 * wording because its subject is the platform's display name, so no special-casing is needed here.
 */
export function gestureRefusalMessage(
  device: DeviceInfo,
  tier: GestureRuntimeTier,
  intent: GestureCommandInput['intent'],
): string {
  return `gesture ${intent} is not supported on ${gestureRefusalSubject(device, tier)}`;
}
