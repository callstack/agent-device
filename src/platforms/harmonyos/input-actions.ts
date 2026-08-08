import type { DeviceRotation } from '@agent-device/contracts/device';
import { buildScrollGesturePlan, type ScrollDirection } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '../../utils/timeouts.ts';
import { runHarmonyHdc } from './hdc.ts';

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
  // API 24 exposes no stable display-size command. The tested 1080×2340
  // viewport is conservative for both the supplied emulator and Mate 60; this
  // is replaced by runtime viewport extraction before broad device support.
  const plan = buildScrollGesturePlan({
    direction,
    amount: options?.amount,
    pixels: options?.pixels,
    referenceWidth: 1080,
    referenceHeight: 2340,
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
    String(options?.durationMs ?? 300),
  ]);
  return plan;
}

export async function backHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Back']);
}

export async function homeHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Home']);
}

export async function appSwitcherHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Recent']);
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
