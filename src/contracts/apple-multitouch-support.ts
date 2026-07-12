import {
  isApplePlatform,
  resolveDeviceAppleOs,
  type AppleOS,
  type DeviceInfo,
} from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import type { GesturePlan } from './gesture-plan-types.ts';

const APPLE_OS_DISPLAY_NAMES: Record<AppleOS, string> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  tvos: 'tvOS',
  watchos: 'watchOS',
  visionos: 'visionOS',
  macos: 'macOS',
};

const APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS: Partial<Record<AppleOS, string>> = {
  visionos: 'visionOS uses spatial input and does not support two-finger touch synthesis.',
  tvos: 'tvOS has no touch input — this gesture is supported on Android and the iOS simulator only.',
  macos:
    'macOS automation has no multi-touch input — this gesture is supported on Android and the iOS simulator only.',
};

/** One policy shared by command admission and the defensive Apple adapter check. */
export function assertAppleMultiTouchSupported(
  device: DeviceInfo,
  intent: GesturePlan['intent'],
): void {
  if (!isApplePlatform(device.platform)) {
    throw unsupported(intent, device.platform);
  }
  const appleOs = resolveDeviceAppleOs(device);
  if ((appleOs === 'ios' || appleOs === 'ipados') && device.kind === 'simulator') return;
  if (appleOs === 'ios' || appleOs === 'ipados') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `gesture ${intent} is not supported on physical iOS devices`,
      {
        hint: 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.',
      },
    );
  }
  throw unsupported(
    intent,
    APPLE_OS_DISPLAY_NAMES[appleOs],
    APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS[appleOs],
  );
}

function unsupported(intent: GesturePlan['intent'], platform: string, hint?: string): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `gesture ${intent} is not supported on ${platform}`,
    hint === undefined ? undefined : { hint },
  );
}
