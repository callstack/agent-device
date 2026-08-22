/**
 * Pointer, key, and gesture actions on an Android device. Text entry — provider injection, the test
 * IME, and the adb-shell writer — is `text-input.ts`.
 */
import { DEVICE_ROTATION_SURFACE_INDEX, type DeviceRotation } from '@agent-device/contracts/device';
import { buildGesturePlan } from '@agent-device/contracts/gesture-plan';
import { GESTURE_DURATION_MIN_MS } from '@agent-device/contracts/gesture-plan-types';
import { DEFAULT_MOBILE_SCROLL_DURATION_MS } from '@agent-device/contracts/scroll-command';
import {
  type ScrollDirection,
  buildScrollGesturePlan,
} from '@agent-device/contracts/scroll-gesture';
import { type TvRemoteButton, toAndroidTvRemoteKeyevent } from '@agent-device/contracts/tv-remote';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runAndroidAdb } from './adb.ts';
import { executeAndroidTouchPlan, readAndroidGestureViewport } from './touch-executor.ts';
import type { AndroidHelperSessionOptions } from './snapshot-helper-types.ts';

export async function pressAndroid(device: DeviceInfo, x: number, y: number): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'tap', String(x), String(y)]);
}

export async function pressAndroidTvRemote(
  device: DeviceInfo,
  button: TvRemoteButton,
  durationMs?: number,
): Promise<void> {
  const keyevent = toAndroidTvRemoteKeyevent(button);
  const keyeventArgs = durationMs && durationMs > 0 ? ['keyevent', '--longpress'] : ['keyevent'];
  await runAndroidAdb(device, ['shell', 'input', ...keyeventArgs, keyevent]);
}

export async function backAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '4']);
}

export async function homeAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '3']);
}

export async function pressAndroidEnter(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', 'ENTER']);
}

export async function setAndroidOrientation(
  device: DeviceInfo,
  orientation: DeviceRotation,
): Promise<void> {
  const userRotation = resolveAndroidUserRotation(orientation);
  await runAndroidAdb(device, [
    'shell',
    'settings',
    'put',
    'system',
    'accelerometer_rotation',
    '0',
  ]);
  await runAndroidAdb(device, [
    'shell',
    'settings',
    'put',
    'system',
    'user_rotation',
    userRotation,
  ]);
}

export async function appSwitcherAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '187']);
}

export async function longPressAndroid(
  device: DeviceInfo,
  x: number,
  y: number,
  durationMs = 800,
): Promise<Record<string, unknown>> {
  const point = { x, y };
  return await executeAndroidTouchPlan(device, {
    topology: 'single',
    intent: 'longPress',
    durationMs,
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point },
          { offsetMs: durationMs, point },
        ],
      },
    ],
  });
}

export async function focusAndroid(device: DeviceInfo, x: number, y: number): Promise<void> {
  await pressAndroid(device, x, y);
}

export async function scrollAndroid(
  device: DeviceInfo,
  direction: ScrollDirection,
  options?: { amount?: number; pixels?: number; durationMs?: number } & AndroidHelperSessionOptions,
): Promise<Record<string, unknown>> {
  // The viewport read and the gesture are two helper calls one command apart: giving the read the
  // command's session scope keeps both on the same instrumentation.
  const viewport = await readAndroidGestureViewport(device, {
    helperSessionScope: options?.helperSessionScope,
  });
  const relativePlan = buildScrollGesturePlan({
    direction,
    amount: options?.amount,
    pixels: options?.pixels,
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  });
  const scrollPlan = {
    ...relativePlan,
    // Injected coordinates are absolute, so their zero-origin reference frame
    // must include the viewport offset as well as its dimensions.
    referenceWidth: viewport.x + viewport.width,
    referenceHeight: viewport.y + viewport.height,
    x1: viewport.x + relativePlan.x1,
    y1: viewport.y + relativePlan.y1,
    x2: viewport.x + relativePlan.x2,
    y2: viewport.y + relativePlan.y2,
  };
  const durationMs = Math.max(
    options?.durationMs ?? DEFAULT_MOBILE_SCROLL_DURATION_MS,
    GESTURE_DURATION_MIN_MS,
  );
  const backend = await executeAndroidTouchPlan(
    device,
    buildGesturePlan(
      {
        intent: 'pan',
        origin: { x: scrollPlan.x1, y: scrollPlan.y1 },
        delta: {
          x: scrollPlan.x2 - scrollPlan.x1,
          y: scrollPlan.y2 - scrollPlan.y1,
        },
        durationMs,
      },
      viewport,
      'android',
    ),
  );

  return {
    ...scrollPlan,
    ...(options?.durationMs !== undefined ? { durationMs } : {}),
    ...backend,
  };
}

function resolveAndroidUserRotation(orientation: DeviceRotation): string {
  const index = DEVICE_ROTATION_SURFACE_INDEX[orientation];
  if (index === undefined) {
    throw new AppError('INVALID_ARGS', `Unsupported Android rotation: ${orientation}`);
  }
  return String(index);
}

export async function getAndroidScreenSize(
  device: DeviceInfo,
): Promise<{ width: number; height: number }> {
  const result = await runAndroidAdb(device, ['shell', 'wm', 'size']);
  const match = result.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) throw new AppError('COMMAND_FAILED', 'Unable to read screen size');
  return { width: Number(match[1]), height: Number(match[2]) };
}
