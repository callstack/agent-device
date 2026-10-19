import {
  isApplePlatform,
  resolveDeviceAppleOs,
  type AppleOS,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import type { GestureCommandInput } from './gesture-plan-types.ts';
import type { GestureRuntimeTier } from './gesture-tier.ts';

/**
 * How each Apple OS names itself in agent-facing prose.
 *
 * Owned here because every subject that needs the wording is a gesture refusal: the refusal
 * subject below and the Apple adapter's own check (`packages/platform-apple/src/
 * multitouch-support.ts`). One table keeps both refusals spelling an OS the same way.
 */
export const APPLE_OS_DISPLAY_NAMES: Record<AppleOS, string> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  tvos: 'tvOS',
  watchos: 'watchOS',
  visionos: 'visionOS',
  macos: 'macOS',
};

/** The hint an owner states when it cannot preserve a target-authored drag's timing. */
export const TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT =
  'Target-authored drag requires an adapter that preserves source hold, timed movement, and destination hold; it is supported on Android touch devices and iOS/iPadOS.';

/** The hint the Android owner states for a TV target, which has no touch input at all. */
export const ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT =
  'Android TV has no touch input — this gesture is supported on Android phones, tablets, iOS, and iPadOS.';

/**
 * How a refused cell names itself, reproducing every subject the retired admission produced.
 *
 * Owner-specific subjects, then the plain platform name. The special cases resolve the
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
 * The owner-specific subjects two-contact synthesis refusals use, or `undefined` for the plain
 * platform name. iOS and iPadOS are named only for a provider refusal: the Apple owner admits
 * multi-touch on simulators and devices, and the provider's hint says why it does not.
 */
function multiTouchRefusalSubject(device: DeviceInfo): string | undefined {
  if (device.platform === 'android') return device.target === 'tv' ? 'Android TV' : undefined;
  if (!isApplePlatform(device.platform)) return undefined;
  const appleOs = resolveDeviceAppleOs(device);
  if (
    appleOs === 'ios' ||
    appleOs === 'ipados' ||
    appleOs === 'macos' ||
    appleOs === 'tvos' ||
    appleOs === 'visionos'
  ) {
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
