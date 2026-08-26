import type { DeviceRotation } from '@agent-device/contracts/device';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import { DEFAULT_MOBILE_SCROLL_DURATION_MS } from '@agent-device/contracts/scroll-command';
import {
  type ScrollDirection,
  buildScrollGesturePlan,
} from '@agent-device/contracts/scroll-gesture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '../../utils/timeouts.ts';
import { runHarmonyHdc } from './hdc.ts';
import { invalidateHarmonyGestureViewport, readHarmonyGestureViewport } from './snapshot.ts';

export async function pressHarmony(device: DeviceInfo, x: number, y: number): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'click', String(x), String(y)]);
}

export async function doubleClickHarmony(device: DeviceInfo, x: number, y: number): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'doubleClick', String(x), String(y)]);
}

export async function longPressHarmony(
  device: DeviceInfo,
  x: number,
  y: number,
  _durationMs = 800,
): Promise<void> {
  // API 24's native longClick produces the actual ArkUI long-press gesture. A
  // stationary swipe returns success but does not dispatch LongPressGesture on
  // either verified target, so do not treat it as an equivalent fallback.
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'longClick', String(x), String(y)]);
}

export async function typeHarmony(device: DeviceInfo, text: string, delayMs = 0): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'text', text]);
  if (delayMs > 0) await sleep(delayMs);
}

export async function fillHarmony(
  device: DeviceInfo,
  x: number,
  y: number,
  text: string,
  delayMs = 0,
): Promise<void> {
  // `inputText` focuses the exact point before writing. It is the supported API 24
  // path and avoids relying on desktop-only Ctrl+A key aliases.
  await runHarmonyHdc(device, [
    'shell',
    'uitest',
    'uiInput',
    'inputText',
    String(x),
    String(y),
    text,
  ]);
  if (delayMs > 0) await sleep(delayMs);
}

export async function scrollHarmony(
  device: DeviceInfo,
  direction: ScrollDirection,
  options?: { amount?: number; pixels?: number; durationMs?: number },
): Promise<Record<string, unknown>> {
  const viewport = await readHarmonyGestureViewport(device);
  const plan = buildScrollGesturePlan({
    direction,
    amount: options?.amount,
    pixels: options?.pixels,
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  });
  await runHarmonyHdc(device, [
    'shell',
    'uitest',
    'uiInput',
    'swipe',
    String(plan.x1),
    String(plan.y1),
    String(plan.x2),
    String(plan.y2),
    String(options?.durationMs ?? DEFAULT_MOBILE_SCROLL_DURATION_MS),
  ]);
  return plan;
}

/** Lowers HDC's public one-pointer primitives from a shared semantic plan. */
export async function performHarmonyGesture(
  device: DeviceInfo,
  plan: GesturePlan,
): Promise<Record<string, unknown>> {
  if (plan.topology !== 'single') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'HarmonyOS HDC does not support multi-touch gestures',
    );
  }
  const samples = plan.pointers[0].samples;
  const start = samples[0];
  const end = samples.at(-1);
  if (!start || !end) {
    throw new AppError('COMMAND_FAILED', 'HarmonyOS gesture plan has no pointer endpoints');
  }
  const distance = Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y);
  const velocity = Math.max(
    200,
    Math.min(40_000, Math.round((distance / plan.durationMs) * 1_000)),
  );
  const command = plan.intent === 'fling' ? 'fling' : 'swipe';
  await runHarmonyHdc(device, [
    'shell',
    'uitest',
    'uiInput',
    command,
    String(Math.round(start.point.x)),
    String(Math.round(start.point.y)),
    String(Math.round(end.point.x)),
    String(Math.round(end.point.y)),
    String(velocity),
  ]);
  return { backend: 'harmonyos-hdc-uiinput', command, velocity, viewport: plan.viewport };
}

export async function backHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Back']);
  invalidateHarmonyGestureViewport(device);
}

export async function homeHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Home']);
  invalidateHarmonyGestureViewport(device);
}

export async function appSwitcherHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Recent']);
  invalidateHarmonyGestureViewport(device);
}

export async function pressHarmonyKeyboardKey(
  device: DeviceInfo,
  key: 'Enter' | 'Back',
): Promise<void> {
  if (key === 'Back') {
    await backHarmony(device);
    return;
  }
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'keyEvent', key]);
}

export async function setHarmonyOrientation(
  _device: DeviceInfo,
  _orientation: DeviceRotation,
): Promise<void> {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'HarmonyOS orientation control is not available through the public HDC API.',
  );
}
