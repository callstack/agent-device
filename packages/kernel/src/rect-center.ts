import { centerOfRect, type Point, type Rect } from '@agent-device/kernel/snapshot';

const RECT_COMPARE_FIELDS = ['x', 'y', 'width', 'height'] as const;
const RECT_EQUALITY_TOLERANCE = 0.5;

/**
 * The band within which two independently captured rects count as ONE position. Wider than
 * {@link areRectsApproximatelyEqual}'s band, which asks whether two values denote one point: this
 * one asks whether capture rounding counts as motion, and 1 px is the drift a backend's own
 * rounding can produce on a node that never moved.
 */
const CAPTURE_RECT_TOLERANCE_PX = 1;

export function resolveRectCenter(rect: Rect | undefined): { x: number; y: number } | null {
  const normalized = normalizeRect(rect);
  if (!normalized) return null;
  const center = centerOfRect(normalized);
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;
  return center;
}

export function normalizeRect(rect: Rect | undefined): Rect | null {
  if (!rect) return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

export function areRectsApproximatelyEqual(
  left: Rect | undefined,
  right: Rect | undefined,
): boolean {
  if (!left || !right) return false;
  return RECT_COMPARE_FIELDS.every(
    (key) => Math.abs(left[key] - right[key]) <= RECT_EQUALITY_TOLERANCE,
  );
}

/**
 * Whether two observations put a target at the SAME POSITION — the one rule that decides whether
 * capture rounding counts as motion, for every comparison of rects captured at different instants.
 *
 * Normalizes through {@link normalizeRect} first, so a rect that reports no position (absent,
 * non-finite, inverted) never compares equal to anything: absence is the surface having changed
 * under the point, never agreement.
 */
export function areCapturedRectsAtSamePosition(
  first: Rect | undefined,
  second: Rect | undefined,
): boolean {
  const left = normalizeRect(first);
  const right = normalizeRect(second);
  if (!left || !right) return false;
  return RECT_COMPARE_FIELDS.every(
    (key) => Math.abs(left[key] - right[key]) <= CAPTURE_RECT_TOLERANCE_PX,
  );
}

export function pointInsideRect(rect: Rect): Point {
  return {
    x: interiorCoordinate(rect.x, rect.width),
    y: interiorCoordinate(rect.y, rect.height),
  };
}

export function interiorCoordinate(origin: number, size: number): number {
  // Preserve one-pixel edge controls instead of nudging coordinates outside
  // tiny rects through normal center/bounds clamping.
  if (size <= 1) return Math.floor(origin);
  const min = Math.ceil(origin);
  const max = Math.floor(origin + size - 1);
  return Math.round(Math.min(max, Math.max(min, origin + size / 2)));
}
