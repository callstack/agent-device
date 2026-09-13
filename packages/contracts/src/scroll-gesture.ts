import { AppError } from '@agent-device/kernel/errors';
import { defineStringEnum } from './string-enum.ts';
import { isViewportRootNode } from './snapshot-visibility.ts';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

// What a caller may ASK for, as opposed to `ScrollDirection` (what the gesture resolves to):
// `top`/`bottom` are scroll-to-extreme requests with no direction of their own. Declared here
// rather than in the command runtime that resolves them, so the public `ScrollOptions` can be
// stated without depending on `commands/`.
export const SCROLL_INPUT_DIRECTIONS = ['up', 'down', 'left', 'right', 'top', 'bottom'] as const;
export type ScrollInputDirection = (typeof SCROLL_INPUT_DIRECTIONS)[number];

export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];
export const SWIPE_PRESETS = ['left', 'right', 'left-edge', 'right-edge'] as const;
export type SwipePreset = (typeof SWIPE_PRESETS)[number];
export const SWIPE_PATTERNS = ['one-way', 'ping-pong'] as const;
export type SwipePattern = (typeof SWIPE_PATTERNS)[number];
export const SWIPE_REPETITION_MAX = 200;
export const SWIPE_PAUSE_MAX_MS = 10_000;
export const SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS = 60_000;
const SCROLL_DIRECTION_ENUM = defineStringEnum(SCROLL_DIRECTIONS, {
  message: (direction) => `Unknown direction: ${direction}`,
});

export type TransformGestureParams = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  scale: number;
  degrees: number;
  durationMs?: number;
};

export type GestureReferenceFrame = {
  referenceWidth: number;
  referenceHeight: number;
};

type GesturePoint = {
  x: number;
  y: number;
};

export type ScrollGestureOptions = {
  direction: ScrollDirection;
  amount?: number;
  pixels?: number;
  referenceWidth: number;
  referenceHeight: number;
};

export type ScrollGesturePlan = {
  direction: ScrollDirection;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  referenceWidth: number;
  referenceHeight: number;
  amount?: number;
  pixels: number;
};

export type SwipePresetGesturePlan = {
  preset: SwipePreset;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  referenceWidth: number;
  referenceHeight: number;
};

export type InPageSwipeGesturePlan = {
  direction: ScrollDirection;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  referenceWidth: number;
  referenceHeight: number;
};

/**
 * The finger-path fraction of the viewport axis one scroll covers when the caller names no
 * distance. Exported because a backend with no viewport to measure against (the browser) scales its
 * own default step by the ratio to this, and that ratio is only meaningful while both sides read
 * the same number.
 */
export const DEFAULT_SCROLL_AMOUNT = 0.6;
// Scroll gestures never touch the outer 10% of either axis. Modern app windows are edge-to-edge,
// so the viewport includes the system bars: a swipe that starts inside the status bar (5.7% of a
// Pixel 7's height, 6.9% of an iPhone's with a Dynamic Island) pulls the notification shade or
// Notification Center down instead of scrolling. 10% clears both with margin (#1781 A1).
const DEFAULT_EDGE_PADDING_FRACTION = 0.1;
// Edge presets stay close to the system gesture boundary without emitting edge coordinates.
const SWIPE_PRESET_EDGE_MARGIN_PX = 8;

export function buildScrollGesturePlan(options: ScrollGestureOptions): ScrollGesturePlan {
  const direction = options.direction;
  const axisLength =
    direction === 'up' || direction === 'down' ? options.referenceHeight : options.referenceWidth;
  const requestedAmount = resolveRequestedAmount(options.amount);
  const requestedPixels =
    options.pixels !== undefined
      ? normalizeRequestedPixels(options.pixels)
      : Math.round(axisLength * requestedAmount);
  const edgePadding = Math.max(1, Math.round(axisLength * DEFAULT_EDGE_PADDING_FRACTION));
  const maxTravelPixels = Math.max(1, axisLength - edgePadding * 2);
  const travelPixels = Math.max(1, Math.min(requestedPixels, maxTravelPixels));
  const halfTravel = Math.round(travelPixels / 2);
  const centerX = Math.round(options.referenceWidth / 2);
  const centerY = Math.round(options.referenceHeight / 2);
  const buildPlan = (x1: number, y1: number, x2: number, y2: number): ScrollGesturePlan => ({
    direction,
    x1,
    y1,
    x2,
    y2,
    referenceWidth: options.referenceWidth,
    referenceHeight: options.referenceHeight,
    amount: options.amount,
    pixels: travelPixels,
  });

  switch (direction) {
    case 'up':
      return buildPlan(centerX, centerY - halfTravel, centerX, centerY + halfTravel);
    case 'down':
      return buildPlan(centerX, centerY + halfTravel, centerX, centerY - halfTravel);
    case 'left':
      return buildPlan(centerX - halfTravel, centerY, centerX + halfTravel, centerY);
    case 'right':
      return buildPlan(centerX + halfTravel, centerY, centerX - halfTravel, centerY);
  }
}

/**
 * Validates pre-frame scroll inputs (amount/pixels) the same way buildScrollGesturePlan would,
 * so the daemon throws INVALID_ARGS for bad inputs BEFORE sending the fused runner `scroll`
 * command (previously validation ran between the frame request and the drag). The resolved
 * values are discarded; only their throw-on-invalid behavior is reused.
 */
export function assertScrollGestureInput(options: { amount?: number; pixels?: number }): void {
  resolveRequestedAmount(options.amount);
  if (options.pixels !== undefined) {
    normalizeRequestedPixels(options.pixels);
  }
}

export function buildSwipePresetGesturePlan(
  preset: SwipePreset,
  frame: GestureReferenceFrame,
): SwipePresetGesturePlan {
  if (preset === 'left' || preset === 'right') {
    const plan = buildInPageSwipeGesturePlan(preset, frame);
    return {
      preset,
      x1: plan.x1,
      y1: plan.y1,
      x2: plan.x2,
      y2: plan.y2,
      referenceWidth: plan.referenceWidth,
      referenceHeight: plan.referenceHeight,
    };
  }
  const [startPercent, endPercent] = preset === 'left-edge' ? [99, 15] : [1, 85];
  const start = clampGesturePoint(
    pointFromPercent(frame, startPercent, 50),
    frame,
    SWIPE_PRESET_EDGE_MARGIN_PX,
  );
  const end = clampGesturePoint(
    pointFromPercent(frame, endPercent, 50),
    frame,
    SWIPE_PRESET_EDGE_MARGIN_PX,
  );
  return {
    preset,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    referenceWidth: frame.referenceWidth,
    referenceHeight: frame.referenceHeight,
  };
}

export function gestureDirectionDelta(direction: ScrollDirection, distance: number): GesturePoint {
  switch (direction) {
    case 'up':
      return { x: 0, y: -distance };
    case 'down':
      return { x: 0, y: distance };
    case 'left':
      return { x: -distance, y: 0 };
    case 'right':
      return { x: distance, y: 0 };
  }
}

/** Plans a centered, edge-inset finger motion that remains inside app content. */
export function buildInPageSwipeGesturePlan(
  direction: ScrollDirection,
  frame: GestureReferenceFrame,
): InPageSwipeGesturePlan {
  // These insets avoid system-edge gestures while retaining enough travel for pagers.
  const startPercent = 85;
  const endPercent = 15;
  const centerPercent = 50;
  const forward = direction === 'left' || direction === 'up';
  const startAxisPercent = forward ? startPercent : endPercent;
  const endAxisPercent = forward ? endPercent : startPercent;
  const vertical = direction === 'up' || direction === 'down';
  const start = clampGesturePoint(
    pointFromPercent(
      frame,
      vertical ? centerPercent : startAxisPercent,
      vertical ? startAxisPercent : centerPercent,
    ),
    frame,
    SWIPE_PRESET_EDGE_MARGIN_PX,
  );
  const end = clampGesturePoint(
    pointFromPercent(
      frame,
      vertical ? centerPercent : endAxisPercent,
      vertical ? endAxisPercent : centerPercent,
    ),
    frame,
    SWIPE_PRESET_EDGE_MARGIN_PX,
  );
  return {
    direction,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    referenceWidth: frame.referenceWidth,
    referenceHeight: frame.referenceHeight,
  };
}

export function inferGestureReferenceFrame(
  nodes: Array<Pick<SnapshotNode, 'type' | 'rect'>>,
): GestureReferenceFrame | undefined {
  const viewportRect = inferViewportRect(nodes);
  if (!viewportRect) return undefined;
  return {
    referenceWidth: viewportRect.width,
    referenceHeight: viewportRect.height,
  };
}

function pointFromPercent(
  frame: GestureReferenceFrame,
  xPercent: number,
  yPercent: number,
): GesturePoint {
  const x = Math.trunc((frame.referenceWidth * xPercent) / 100);
  const y = Math.trunc((frame.referenceHeight * yPercent) / 100);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function clampGesturePoint(
  point: GesturePoint,
  frame: GestureReferenceFrame,
  marginPx: number,
): GesturePoint {
  return {
    x: clampGestureCoordinate(point.x, marginPx, frame.referenceWidth),
    y: clampGestureCoordinate(point.y, marginPx, frame.referenceHeight),
  };
}

export function parseScrollDirection(direction: string): ScrollDirection {
  return SCROLL_DIRECTION_ENUM.parse(direction);
}

function inferViewportRect(nodes: Array<Pick<SnapshotNode, 'type' | 'rect'>>): Rect | undefined {
  const candidate = nodes
    .filter((node) => isViewportRootNode(node) && isValidRect(node.rect))
    .map((node) => node.rect)
    .sort(
      (left, right) =>
        (right?.width ?? 0) * (right?.height ?? 0) - (left?.width ?? 0) * (left?.height ?? 0),
    )[0];
  if (candidate) return candidate;

  const rects = nodes.map((node) => node.rect).filter(isValidRect);
  if (rects.length === 0) return undefined;

  const width = Math.max(...rects.map((rect) => rect.x + rect.width));
  const height = Math.max(...rects.map((rect) => rect.y + rect.height));
  if (width <= 0 || height <= 0) return undefined;
  return { x: 0, y: 0, width, height };
}

function isValidRect(rect: Rect | undefined): rect is Rect {
  return !!rect && rect.width > 0 && rect.height > 0;
}

function resolveRequestedAmount(amount: number | undefined): number {
  if (amount === undefined) return DEFAULT_SCROLL_AMOUNT;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('INVALID_ARGS', 'scroll amount must be a positive number');
  }
  return amount;
}

function normalizeRequestedPixels(pixels: number): number {
  if (!Number.isFinite(pixels) || pixels <= 0) {
    throw new AppError('INVALID_ARGS', 'scroll pixels must be a positive integer');
  }
  return Math.max(1, Math.round(pixels));
}

export function clampGestureCoordinate(value: number, marginPx: number, size: number): number {
  const min = Math.round(marginPx);
  if (!Number.isFinite(min)) return 0;

  const max = Math.max(min, Math.round(size - marginPx));
  if (!Number.isFinite(max) || !Number.isFinite(value)) return min;

  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * What an on-screen keyboard leaves of the scroll viewport, and what happens when it leaves too
 * little.
 *
 * `buildScrollGesturePlan` centres a directional swipe, so a focused field puts its lower endpoint
 * under the keyboard: the gesture lands on keys, the surface never moves, and the edge loop reads a
 * stuck container (#2499) instead of a refusal. Reducing the reference height BEFORE the planner
 * runs keeps the swipe inside what is visible without touching the planner, so reported travel
 * stays honest. The runner and the Android helper each read their own live keyboard frame; a frame
 * threaded from the daemon would be a snapshot that predates the keyboard.
 *
 * Pure geometry, so the decision is proven against a golden table both this file and the Swift twin
 * (`ScrollViewportPolicy` in apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/
 * RunnerScrollViewportPolicy.swift) assert against, so drift turns CI red without a simulator. The
 * table carries only frames representable in both languages: `CGRect` standardizes a negative
 * extent into a positive height at a moved origin, so a negative `height` is tested here alone.
 */

/** Below this fraction of the viewport, the clipped band cannot hold a reliable swipe. */
export const SCROLL_KEYBOARD_MIN_VISIBLE_FRACTION = 0.15;

/**
 * A fixed allowance kept above the keyboard's top edge, in the frame's own unit (points on iOS,
 * pixels on Android). `keyboard.frame` reports the key plane, not the input accessory or composer
 * bar riding above it, so a swipe that ends exactly at the reported edge can still land on a bar.
 */
export const SCROLL_KEYBOARD_ACCESSORY_ALLOWANCE = 12;

/**
 * The one reason a directional scroll refuses to swipe at all (#2500), with the hint every owner
 * publishes beside it: Android measures the occlusion in this process, and the iOS runner answers
 * with its own runner code that the Apple scroll owner joins to these same details, so a
 * caller branches on `reason` and reads one hint whichever owner refused. Avoidance never dismisses
 * the keyboard: a dismiss drops focus, which breaks a `type`/`scroll`/`type` loop, is not idempotent
 * across platforms, and mutates state session-action provenance does not record. So the hint names
 * the tradeoff instead of paying it.
 */
export const SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON = 'scroll_keyboard_occludes_surface';

export const SCROLL_KEYBOARD_OCCLUDES_SURFACE_DETAILS = Object.freeze({
  reason: SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON,
  hint:
    'The on-screen keyboard covers the surface this scroll would swipe, so it cannot reach it. ' +
    'Run `keyboard dismiss` and retry, accepting that it drops focus (re-tap the field to keep typing), or scroll before focusing the field.',
});

export type ScrollKeyboardClip =
  /** No keyboard, or one that does not own this surface: swipe the whole viewport. */
  | { kind: 'unobstructed' }
  /** The viewport trimmed above the keyboard. Report the reduced reference height honestly. */
  | { kind: 'avoided'; viewport: Rect; keyboardMinY: number }
  /**
   * Too little surface left above the keyboard to swipe. Swiping anyway reads as a stuck
   * container to the no-progress fingerprint, so the caller refuses with
   * `SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON` instead.
   */
  | { kind: 'occluded'; keyboardMinY: number; visibleHeight: number };

/** The numbers a refusing owner names about the surface it declined to swipe. */
export type ScrollKeyboardOcclusion = {
  keyboardMinY: number;
  visibleHeight: number;
  viewportHeight: number;
};

/**
 * Clips a scroll viewport to the band above an occluding keyboard.
 *
 * Fails open on an unusable frame: a keyboard the platform cannot measure is not evidence that the
 * surface is blocked, and turning a missing frame into a refusal would refuse every scroll on a
 * device with a broken keyboard query. The floor is the caller's refusal, not this rule.
 */
export function clipScrollViewportAboveKeyboard(
  viewport: Rect,
  keyboard: Rect,
): ScrollKeyboardClip {
  if (!isMeasurableRect(viewport) || !isMeasurableRect(keyboard)) return { kind: 'unobstructed' };
  // A vertical swipe runs along the viewport's centre line, which is the only part of the width the
  // keyboard has to reach to be struck: a 320pt keyboard centred in an 834pt viewport is 38% of the
  // width and sits exactly in the path. A horizontal swipe runs along the OTHER centre line, so
  // clipping it too is early rather than wrong — it only lifts the swipe clear of the keys.
  const swipeCenterX = viewport.x + viewport.width / 2;
  if (swipeCenterX < keyboard.x || swipeCenterX >= keyboard.x + keyboard.width) {
    return { kind: 'unobstructed' };
  }
  const keyboardMinY = keyboard.y;
  if (keyboardMinY >= viewport.y + viewport.height || keyboard.y + keyboard.height <= viewport.y) {
    return { kind: 'unobstructed' };
  }
  const visibleHeight = Math.max(
    0,
    keyboardMinY - SCROLL_KEYBOARD_ACCESSORY_ALLOWANCE - viewport.y,
  );
  if (visibleHeight < SCROLL_KEYBOARD_MIN_VISIBLE_FRACTION * viewport.height) {
    return { kind: 'occluded', keyboardMinY, visibleHeight };
  }
  return {
    kind: 'avoided',
    viewport: { ...viewport, height: visibleHeight },
    keyboardMinY,
  };
}

/**
 * The refusal an owner that measured the keyboard in this process reports. The iOS runner measures
 * in its own coordinate space and answers with its runner code instead; the Apple scroll owner
 * adds the same `SCROLL_KEYBOARD_OCCLUDES_SURFACE_DETAILS` to that error.
 */
export function scrollKeyboardOccludesSurfaceError(
  direction: ScrollDirection,
  occlusion: ScrollKeyboardOcclusion,
): AppError {
  const percent = Math.round(SCROLL_KEYBOARD_MIN_VISIBLE_FRACTION * 100);
  return new AppError(
    'COMMAND_FAILED',
    `scroll ${direction} refused: the keyboard leaves ${occlusion.visibleHeight}px of ${occlusion.viewportHeight}px visible, below the ${percent}% needed for a swipe`,
    {
      keyboardMinY: occlusion.keyboardMinY,
      visibleHeight: occlusion.visibleHeight,
      viewportHeight: occlusion.viewportHeight,
      minVisibleFraction: SCROLL_KEYBOARD_MIN_VISIBLE_FRACTION,
      ...SCROLL_KEYBOARD_OCCLUDES_SURFACE_DETAILS,
    },
  );
}

function isMeasurableRect(rect: Rect): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value)) &&
    rect.width > 0 &&
    rect.height > 0
  );
}
