import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Rect } from '@agent-device/kernel/snapshot';
import { resolveAndroidTouchProvider } from './adb-executor.ts';
import {
  executeAndroidTouchHelperPlan,
  readAndroidTouchHelperViewportReading,
} from './touch-helper.ts';
import {
  validateAndroidGestureViewport,
  type AndroidGestureViewportReading,
} from './gesture-viewport.ts';
import { lowerAndroidTouchPlan, type AndroidTouchPlan } from './touch-plan-lowering.ts';
import type { AndroidHelperSessionOptions } from './snapshot-helper-types.ts';

export async function executeAndroidTouchPlan(
  device: DeviceInfo,
  plan: AndroidTouchPlan,
): Promise<Record<string, unknown>> {
  const loweredPlan = lowerAndroidTouchPlan(plan);
  const provider = resolveAndroidTouchProvider(device);
  if (provider) {
    const providerPlan =
      loweredPlan.intent === 'longPress'
        ? {
            ...loweredPlan,
            viewport: validateAndroidGestureViewport(await provider.gestureViewport()),
          }
        : loweredPlan;
    const result = (await provider.touch(providerPlan)) ?? {};
    return { backend: 'provider-native-touch', ...result };
  }
  return await executeAndroidTouchHelperPlan(device, loweredPlan);
}

export async function readAndroidGestureViewport(
  device: DeviceInfo,
  helper: AndroidHelperSessionOptions = {},
): Promise<Rect> {
  return (await readAndroidGestureViewportReading(device, helper)).viewport;
}

/**
 * The application viewport and the input method window's share of it, from one live window read.
 *
 * `scroll` needs both: a swipe planned against the unobstructed window lands on the keyboard when a
 * field is focused, and a frame cached by an earlier command predates the keyboard. A
 * provider-supplied viewport has no IME channel, so it reports no keyboard — which the clip rule
 * reads as "nothing to avoid" rather than as an occlusion.
 */
export async function readAndroidGestureViewportReading(
  device: DeviceInfo,
  helper: AndroidHelperSessionOptions = {},
): Promise<AndroidGestureViewportReading> {
  const provider = resolveAndroidTouchProvider(device);
  if (provider) {
    return { viewport: validateAndroidGestureViewport(await provider.gestureViewport()) };
  }
  return await readAndroidTouchHelperViewportReading(device, helper);
}
