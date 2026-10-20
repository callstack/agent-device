import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Point, Rect } from '@agent-device/kernel/snapshot';
import { COORDINATE_GESTURE_KINDS, type GesturePayload } from './gesture-input.ts';
import { buildGesturePlan } from './gesture-plan.ts';
import type { GesturePlan, MultiTouchGesturePlan } from './gesture-plan-types.ts';
import { SCROLL_DIRECTIONS, SWIPE_PRESETS } from './scroll-gesture.ts';

export const PORTRAIT: Rect = { x: 0, y: 0, width: 390, height: 844 };
export const LANDSCAPE: Rect = { x: 0, y: 0, width: 844, height: 390 };

export function requireTwoPointerPlan(
  plan: ReturnType<typeof buildGesturePlan>,
): MultiTouchGesturePlan {
  assert.equal(plan.topology, 'multi');
  return plan as MultiTouchGesturePlan;
}

export function finalSpan(plan: MultiTouchGesturePlan): number {
  return distance(
    requiredPoint(plan.pointers[0].samples.at(-1)?.point),
    requiredPoint(plan.pointers[1].samples.at(-1)?.point),
  );
}

export function initialSpan(plan: MultiTouchGesturePlan): number {
  return distance(
    requiredPoint(plan.pointers[0].samples[0]?.point),
    requiredPoint(plan.pointers[1].samples[0]?.point),
  );
}

export function centroid(plan: MultiTouchGesturePlan, index: number): Point {
  const first = requiredPoint(
    index === -1 ? plan.pointers[0].samples.at(-1)?.point : plan.pointers[0].samples[index]?.point,
  );
  const second = requiredPoint(
    index === -1 ? plan.pointers[1].samples.at(-1)?.point : plan.pointers[1].samples[index]?.point,
  );
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

export function rotationDelta(plan: MultiTouchGesturePlan): number {
  const start = vectorAngle(
    requiredPoint(plan.pointers[0].samples[0]?.point),
    requiredPoint(plan.pointers[1].samples[0]?.point),
  );
  const end = vectorAngle(
    requiredPoint(plan.pointers[0].samples.at(-1)?.point),
    requiredPoint(plan.pointers[1].samples.at(-1)?.point),
  );
  return normalizeDegrees(end - start);
}

export function assertAllSamplesInViewport(plan: GesturePlan): void {
  for (const pointer of plan.pointers) {
    for (const { point } of pointer.samples) {
      assert.ok(point.x >= plan.viewport.x && point.x <= plan.viewport.x + plan.viewport.width);
      assert.ok(point.y >= plan.viewport.y && point.y <= plan.viewport.y + plan.viewport.height);
    }
  }
}

export function requiredPoint(point: Point | undefined): Point {
  assert.ok(point);
  return point;
}

export function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export function normalizedAngle(first: Point, second: Point): number {
  return Math.abs(normalizeDegrees(vectorAngle(first, second)));
}

export function isErrorWithReason(error: unknown, code: string, reason: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; details?: { reason?: unknown } };
  return candidate.code === code && candidate.details?.reason === reason;
}

function vectorAngle(first: Point, second: Point): number {
  return (Math.atan2(first.y - second.y, first.x - second.x) * 180) / Math.PI;
}

function normalizeDegrees(degrees: number): number {
  return ((degrees + 180) % 360) - 180;
}

export const PROPERTY_RUNS_SMALL = 40;

/** Smallest supported iPhone viewports — the geometry examples worth keeping. */
export const COMPACT_VIEWPORTS: readonly Rect[] = [
  { x: 0, y: 0, width: 320, height: 568 },
  { x: 0, y: 0, width: 375, height: 667 },
];

const viewportRectArb: fc.Arbitrary<Rect> = fc.oneof(
  fc.constantFrom(...COMPACT_VIEWPORTS),
  fc.record({
    x: fc.integer({ min: 0, max: 200 }),
    y: fc.integer({ min: 0, max: 200 }),
    width: fc.integer({ min: 1, max: 2400 }),
    height: fc.integer({ min: 1, max: 2400 }),
  }),
);

/** A point sampled from the viewport's own box, so most gestures are plannable. */
function pointInViewportArb(viewport: Rect): fc.Arbitrary<Point> {
  return fc.record({
    x: fc.integer({ min: Math.floor(viewport.x), max: Math.floor(viewport.x + viewport.width) }),
    y: fc.integer({ min: Math.floor(viewport.y), max: Math.floor(viewport.y + viewport.height) }),
  });
}

/**
 * One payload arbitrary per coordinate gesture kind. Keyed by `COORDINATE_GESTURE_KINDS`,
 * so a new coordinate kind fails to typecheck here instead of silently escaping the
 * geometry property. `drag` is not a coordinate kind and is covered by the plan tests.
 */
function gesturePayloadArbByKind(
  viewport: Rect,
): Record<(typeof COORDINATE_GESTURE_KINDS)[number], fc.Arbitrary<GesturePayload>> {
  const origin = pointInViewportArb(viewport);
  const delta = fc.record({
    x: fc.integer({ min: -viewport.width, max: viewport.width }),
    y: fc.integer({ min: -viewport.height, max: viewport.height }),
  });
  const durationMs = fc.option(fc.integer({ min: 16, max: 2000 }), { nil: undefined });
  const scale = fc.double({ min: 0.1, max: 4, noNaN: true, noDefaultInfinity: true });
  return {
    pan: fc.record({
      kind: fc.constant('pan' as const),
      origin,
      delta,
      pointerCount: fc.constantFrom(undefined, 1 as const, 2 as const),
      durationMs,
    }),
    fling: fc.record({
      kind: fc.constant('fling' as const),
      direction: fc.constantFrom(...SCROLL_DIRECTIONS),
      origin,
      distance: fc.option(fc.integer({ min: 1, max: 1200 }), { nil: undefined }),
    }),
    swipe: fc.record({
      kind: fc.constant('swipe' as const),
      preset: fc.constantFrom(...SWIPE_PRESETS),
    }),
    pinch: fc.record({
      kind: fc.constant('pinch' as const),
      scale,
      origin: fc.option(origin, { nil: undefined }),
    }),
    rotate: fc.record({
      kind: fc.constant('rotate' as const),
      degrees: fc.integer({ min: -720, max: 720 }),
      origin: fc.option(origin, { nil: undefined }),
    }),
    transform: fc.record({
      kind: fc.constant('transform' as const),
      origin,
      delta,
      scale,
      degrees: fc.integer({ min: -720, max: 720 }),
      durationMs,
    }),
    tap: fc.record({
      kind: fc.constant('tap' as const),
      points: fc.uniqueArray(origin, {
        minLength: 2,
        maxLength: 5,
        selector: (point) => `${point.x},${point.y}`,
      }),
      holdMs: fc.option(fc.integer({ min: 16, max: 2000 }), { nil: undefined }),
    }),
  };
}

/** A viewport with a gesture payload of every coordinate kind planned against it. */
export const gestureInViewportArb: fc.Arbitrary<{ viewport: Rect; gesture: GesturePayload }> =
  viewportRectArb.chain((viewport) => {
    const byKind = gesturePayloadArbByKind(viewport);
    return fc.record({
      viewport: fc.constant(viewport),
      gesture: fc.oneof(...COORDINATE_GESTURE_KINDS.map((kind) => byKind[kind])),
    });
  });
