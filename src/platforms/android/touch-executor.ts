import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Rect } from '@agent-device/kernel/snapshot';
import { resolveAndroidTouchProvider } from './adb-executor.ts';
import { executeAndroidTouchHelperPlan, readAndroidTouchHelperViewport } from './touch-helper.ts';
import { validateAndroidGestureViewport } from './gesture-viewport.ts';
import { lowerAndroidTouchPlan, type AndroidTouchPlan } from './touch-plan.ts';

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

export async function readAndroidGestureViewport(device: DeviceInfo): Promise<Rect> {
  const provider = resolveAndroidTouchProvider(device);
  if (provider) return validateAndroidGestureViewport(await provider.gestureViewport());
  return await readAndroidTouchHelperViewport(device);
}
