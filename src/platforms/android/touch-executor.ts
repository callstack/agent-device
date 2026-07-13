import type { DeviceInfo } from '../../kernel/device.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import {
  resolveAndroidGestureViewportProvider,
  resolveAndroidTouchInjector,
} from './adb-executor.ts';
import {
  executeAndroidMultiTouchHelperPlan,
  readAndroidMultiTouchHelperViewport,
} from './multitouch-helper.ts';
import { validateAndroidGestureViewport } from './gesture-viewport.ts';
import type { AndroidTouchPlan } from './touch-plan.ts';

export async function executeAndroidTouchPlan(
  device: DeviceInfo,
  plan: AndroidTouchPlan,
): Promise<Record<string, unknown>> {
  const providerTouch = resolveAndroidTouchInjector(device);
  if (providerTouch) {
    const result = (await providerTouch(plan)) ?? {};
    return { backend: 'provider-native-touch', ...result };
  }
  return await executeAndroidMultiTouchHelperPlan(device, plan);
}

export async function readAndroidGestureViewport(device: DeviceInfo): Promise<Rect> {
  const providerViewport = resolveAndroidGestureViewportProvider(device);
  if (providerViewport) return validateAndroidGestureViewport(await providerViewport());
  return await readAndroidMultiTouchHelperViewport(device);
}
