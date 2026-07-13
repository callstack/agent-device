import type { GesturePlan, PointerTrajectory } from '../../contracts/gesture-plan.ts';
import { AppError } from '../../kernel/errors.ts';
import type { Point, Rect } from '../../kernel/snapshot.ts';

export type AndroidLongPressTouchPlan = {
  topology: 'single';
  intent: 'longPress';
  durationMs: number;
  viewport: Rect;
  pointers: readonly [PointerTrajectory];
};

export type AndroidTouchPlan = GesturePlan | AndroidLongPressTouchPlan;

export function buildAndroidLongPressTouchPlan(
  point: Point,
  durationMs: number,
  viewport: Rect,
): AndroidLongPressTouchPlan {
  assertPointInViewport(point, viewport);
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 120_000) {
    throw new AppError('INVALID_ARGS', 'longPress durationMs must be between 0 and 120000');
  }
  return {
    topology: 'single',
    intent: 'longPress',
    durationMs,
    viewport,
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point },
          { offsetMs: durationMs, point },
        ],
      },
    ],
  };
}

function assertPointInViewport(point: Point, viewport: Rect): void {
  const finite = Number.isFinite(point.x) && Number.isFinite(point.y);
  const contained =
    point.x >= viewport.x &&
    point.y >= viewport.y &&
    point.x < viewport.x + viewport.width &&
    point.y < viewport.y + viewport.height;
  if (!finite || !contained) {
    throw new AppError('GESTURE_TRAJECTORY_OUT_OF_BOUNDS', 'longPress point is outside viewport', {
      point,
      viewport,
    });
  }
}
