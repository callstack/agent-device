import assert from 'node:assert/strict';
import type { Point, Rect } from '../../kernel/snapshot.ts';
import { buildGesturePlan, type MultiTouchGesturePlan } from '../../contracts/gesture-plan.ts';

export const PORTRAIT: Rect = { x: 0, y: 0, width: 390, height: 844 };
export const LANDSCAPE: Rect = { x: 0, y: 0, width: 844, height: 390 };

export function requireTwoPointerPlan(
  plan: ReturnType<typeof buildGesturePlan>,
): MultiTouchGesturePlan {
  assert.equal(plan.topology, 'two');
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

export function assertAllSamplesInViewport(plan: MultiTouchGesturePlan): void {
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
