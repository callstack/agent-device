import { AppError } from '../kernel/errors.ts';
import { defineStringEnum } from '../utils/string-enum.ts';
import type { Rect, SnapshotNode } from '../kernel/snapshot.ts';

export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];
export const SWIPE_PRESETS = ['left', 'right', 'left-edge', 'right-edge'] as const;
export type SwipePreset = (typeof SWIPE_PRESETS)[number];
export const SWIPE_PATTERNS = ['one-way', 'ping-pong'] as const;
export type SwipePattern = (typeof SWIPE_PATTERNS)[number];
const SWIPE_PRESET_ENUM = defineStringEnum(SWIPE_PRESETS, {
  message: 'gesture swipe requires left, right, left-edge, or right-edge',
});
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

export type GesturePoint = {
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

export type SwipeGestureOptions = ScrollGestureOptions;

export type SwipeGesturePlan = Omit<ScrollGesturePlan, 'direction'> & {
  direction: ScrollDirection;
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

const DEFAULT_SCROLL_AMOUNT = 0.6;
const DEFAULT_EDGE_PADDING_FRACTION = 0.05;

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

export function buildSwipeGesturePlan(options: SwipeGestureOptions): SwipeGesturePlan {
  const scrollPlan = buildScrollGesturePlan({
    ...options,
    direction: scrollDirectionForFingerSwipe(options.direction),
  });
  return {
    ...scrollPlan,
    direction: options.direction,
  };
}

export function buildSwipePresetGesturePlan(
  preset: SwipePreset,
  frame: GestureReferenceFrame,
  options: { platform?: string; marginPx?: number } = {},
): SwipePresetGesturePlan {
  const marginPx = options.marginPx ?? 8;
  // Mid-screen keeps in-page swipes on visible content; lower lanes can land in blank pager space.
  const horizontalLanePercent = 50;
  const inPageStartPercent = 85;
  const inPageEndPercent = 15;
  const [startPercent, endPercent, yPercent] =
    preset === 'left'
      ? [inPageStartPercent, inPageEndPercent, horizontalLanePercent]
      : preset === 'right'
        ? [inPageEndPercent, inPageStartPercent, horizontalLanePercent]
        : preset === 'left-edge'
          ? [99, 15, 50]
          : [1, 85, 50];
  const start = pointFromPercent(frame, startPercent, yPercent, { marginPx });
  const end = pointFromPercent(frame, endPercent, yPercent, { marginPx });
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

export function parseSwipePreset(input: string | undefined): SwipePreset {
  return SWIPE_PRESET_ENUM.parse(input);
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

export function pointFromPercent(
  frame: GestureReferenceFrame,
  xPercent: number,
  yPercent: number,
  options: { marginPx?: number } = {},
): GesturePoint {
  const point = {
    x: Math.round((frame.referenceWidth * xPercent) / 100),
    y: Math.round((frame.referenceHeight * yPercent) / 100),
  };
  if (options.marginPx === undefined) return point;
  return clampGesturePoint(point, frame, options.marginPx);
}

export function clampGesturePoint(
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

function scrollDirectionForFingerSwipe(direction: ScrollDirection): ScrollDirection {
  switch (direction) {
    case 'up':
      return 'down';
    case 'down':
      return 'up';
    case 'left':
      return 'right';
    case 'right':
      return 'left';
  }
}

function inferViewportRect(nodes: Array<Pick<SnapshotNode, 'type' | 'rect'>>): Rect | undefined {
  const candidate = nodes
    .filter((node) => isViewportNode(node.type) && isValidRect(node.rect))
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

function isViewportNode(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  return normalized.includes('application') || normalized.includes('window');
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
  const min = marginPx;
  const max = Math.max(min, size - marginPx);
  return clampToRange(value, min, max);
}

export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(Math.round(max), Math.max(Math.round(min), Math.round(value)));
}
