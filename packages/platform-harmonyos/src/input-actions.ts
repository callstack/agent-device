import type { DeviceRotation } from '@agent-device/contracts/device';
import type {
  GesturePlan,
  SinglePointerGesturePlan,
} from '@agent-device/contracts/gesture-plan-types';
import { DEFAULT_MOBILE_SCROLL_DURATION_MS } from '@agent-device/contracts/scroll-command';
import {
  type ScrollDirection,
  buildScrollGesturePlan,
} from '@agent-device/contracts/scroll-gesture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { runHarmonyShell } from './hdc.ts';
import { invalidateHarmonyGestureViewport, readHarmonyGestureViewport } from './snapshot.ts';
import {
  type HarmonyPanTransportRefusalReason,
  type TouchPanelRange,
  harmonyTrajectoryTimeoutMs,
  lowerHarmonyTouchPlan,
  parseHarmonyRenderResolution,
  parseHarmonyTouchDeviceNode,
  parseHarmonyTouchPanelRange,
  renderHarmonyTouchScript,
  resolveHarmonyPanelTransform,
  TRAJECTORY_INJECTION_SENTINEL,
} from './touch-plan-lowering.ts';

export async function pressHarmony(device: DeviceInfo, x: number, y: number): Promise<void> {
  await runHarmonyShell(device, ['uitest', 'uiInput', 'click', x, y]);
}

export async function doubleClickHarmony(device: DeviceInfo, x: number, y: number): Promise<void> {
  await runHarmonyShell(device, ['uitest', 'uiInput', 'doubleClick', x, y]);
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
  await runHarmonyShell(device, ['uitest', 'uiInput', 'longClick', x, y]);
}

export async function typeHarmony(device: DeviceInfo, text: string, delayMs = 0): Promise<void> {
  await runHarmonyShell(device, ['uitest', 'uiInput', 'text', text]);
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
  await runHarmonyShell(device, ['uitest', 'uiInput', 'inputText', x, y, text]);
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
  await runHarmonyShell(device, [
    'uitest',
    'uiInput',
    'swipe',
    plan.x1,
    plan.y1,
    plan.x2,
    plan.y2,
    options?.durationMs ?? DEFAULT_MOBILE_SCROLL_DURATION_MS,
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
  let panTransportRefusal: HarmonyPanTransportRefusalReason | undefined;
  if (plan.intent === 'pan') {
    const attempt = await injectHarmonyPanTrajectory(device, plan);
    if (attempt.state === 'injected') return attempt.record;
    panTransportRefusal = attempt.reason;
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
  await runHarmonyShell(device, [
    'uitest',
    'uiInput',
    command,
    Math.round(start.point.x),
    Math.round(start.point.y),
    Math.round(end.point.x),
    Math.round(end.point.y),
    velocity,
  ]);
  return {
    backend: 'harmonyos-hdc-uiinput',
    command,
    velocity,
    viewport: plan.viewport,
    ...(panTransportRefusal ? { trajectoryFallback: panTransportRefusal } : {}),
  };
}

type ResolvedHarmonyTouchTransport =
  | { kind: 'available'; node: string; range: TouchPanelRange }
  | { kind: 'unavailable'; reason: HarmonyPanTransportRefusalReason };

/**
 * The panel node and its axis range are boot-stable facts, so they resolve once per device id.
 * A locked-down build never resolves, and every pan re-checks the listing rather than caching
 * the denial, so a policy change on the device takes effect without a daemon restart.
 */
const harmonyTouchTransportMemo = new Map<
  string,
  Extract<ResolvedHarmonyTouchTransport, { kind: 'available' }>
>();

async function resolveHarmonyTouchTransport(
  device: DeviceInfo,
): Promise<ResolvedHarmonyTouchTransport> {
  const cached = harmonyTouchTransportMemo.get(device.id);
  if (cached) return cached;
  const listing = await runHarmonyShell(device, ['cat', '/proc/bus/input/devices'], {
    allowFailure: true,
  });
  const node = parseHarmonyTouchDeviceNode(listing.stdout);
  if (!node) {
    const listingRead = listing.stdout.includes('N: Name=');
    return {
      kind: 'unavailable',
      reason: listingRead ? 'touch-node-not-found' : 'touch-node-listing-unreadable',
    };
  }
  const mmiDump = await runHarmonyShell(device, ['hidumper', '-s', 'MultimodalInput', '-a', '-d'], {
    allowFailure: true,
  });
  const rangeResult = parseHarmonyTouchPanelRange(mmiDump.stdout);
  if (rangeResult.kind !== 'range') {
    return {
      kind: 'unavailable',
      reason:
        rangeResult.kind === 'absent' ? 'touch-panel-range-absent' : 'touch-panel-range-ambiguous',
    };
  }
  const resolved = { kind: 'available', node, range: rangeResult.range } as const;
  harmonyTouchTransportMemo.set(device.id, resolved);
  return resolved;
}

/**
 * Injects one pan as a densified sample-carrying trajectory through the panel's evdev node. The
 * chain is verified by the script's own success marker, so a denied or failed panel write can
 * never report a completed gesture. Any unavailability falls back to the uiInput endpoint swipe
 * with the reason carried back to the caller.
 */
async function injectHarmonyPanTrajectory(
  device: DeviceInfo,
  plan: SinglePointerGesturePlan,
): Promise<
  | { state: 'injected'; record: Record<string, unknown> }
  | { state: 'refused'; reason: HarmonyPanTransportRefusalReason }
> {
  const transport = await resolveHarmonyTouchTransport(device);
  if (transport.kind === 'unavailable') {
    return { state: 'refused', reason: transport.reason };
  }
  const renderDump = await runHarmonyShell(
    device,
    ['hidumper', '-s', 'RenderService', '-a', 'screen'],
    { allowFailure: true },
  );
  const transformResult = resolveHarmonyPanelTransform(
    transport.range,
    parseHarmonyRenderResolution(renderDump.stdout),
    plan.viewport,
  );
  if (transformResult.kind !== 'transform') {
    return { state: 'refused', reason: transformResult.kind };
  }
  const trajectory = lowerHarmonyTouchPlan(plan, transformResult.transform);
  const script = renderHarmonyTouchScript(trajectory, { deviceNode: transport.node });
  const result = await runHarmonyShell(device, ['sh', '-c', script], {
    timeoutMs: harmonyTrajectoryTimeoutMs(trajectory),
    allowFailure: true,
  });
  if (!result.stdout.includes(TRAJECTORY_INJECTION_SENTINEL)) {
    throw new AppError('COMMAND_FAILED', 'HarmonyOS touch trajectory injection did not complete', {
      reason: 'touch-trajectory-injection-failed',
      deviceNode: transport.node,
      sampleCount: trajectory.sampleCount,
    });
  }
  return {
    state: 'injected',
    record: {
      backend: 'harmonyos-sendevent-trajectory',
      deviceNode: transport.node,
      sampleCount: trajectory.sampleCount,
      durationMs: trajectory.durationMs,
      viewport: plan.viewport,
    },
  };
}

export async function backHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyShell(device, ['uitest', 'uiInput', 'keyEvent', 'Back']);
  invalidateHarmonyGestureViewport(device);
}

export async function homeHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyShell(device, ['uitest', 'uiInput', 'keyEvent', 'Home']);
  invalidateHarmonyGestureViewport(device);
}

export async function appSwitcherHarmony(device: DeviceInfo): Promise<void> {
  await runHarmonyShell(device, ['uitest', 'uiInput', 'keyEvent', 'Recent']);
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
  await runHarmonyShell(device, ['uitest', 'uiInput', 'keyEvent', key]);
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
