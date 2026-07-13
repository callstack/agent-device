import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { buildGesturePlan, GESTURE_INITIAL_ANGLE_DEGREES } from '../../contracts/gesture-plan.ts';
import {
  centroid,
  distance,
  finalSpan,
  initialSpan,
  LANDSCAPE,
  normalizedAngle,
  PORTRAIT,
  requiredPoint,
  requireTwoPointerPlan,
  rotationDelta,
} from './gesture-plan-test-utils.ts';

describe('single-pointer plans', () => {
  test('pan defaults to one pointer and preserves endpoints and duration', () => {
    const plan = buildGesturePlan(
      { intent: 'pan', origin: { x: 100, y: 200 }, delta: { x: -40, y: 25 } },
      PORTRAIT,
    );
    assert.equal(plan.topology, 'single');
    assert.equal(plan.intent, 'pan');
    assert.equal(plan.durationMs, 500);
    assert.deepEqual(plan.pointers[0].samples[0]?.point, { x: 100, y: 200 });
    assert.deepEqual(plan.pointers[0].samples.at(-1)?.point, { x: 60, y: 225 });
  });

  test('fling has one fixed internal schedule and no public duration', () => {
    const directional = buildGesturePlan(
      { intent: 'fling', direction: 'up', origin: { x: 50, y: 100 }, distance: 80 },
      PORTRAIT,
    );
    const endpoints = buildGesturePlan(
      { intent: 'fling', from: { x: 50, y: 100 }, to: { x: 230, y: 100 } },
      PORTRAIT,
    );
    assert.equal(directional.durationMs, 100);
    assert.equal(endpoints.durationMs, 100);
    assert.deepEqual(directional.pointers[0].samples.at(-1)?.point, { x: 50, y: 20 });
    assert.deepEqual(endpoints.pointers[0].samples.at(-1)?.point, { x: 230, y: 100 });
  });

  test('planner resolves swipe presets inside the active viewport', () => {
    const viewport = { x: 20, y: 30, width: 400, height: 800 };
    const fling = buildGesturePlan({ intent: 'fling', preset: 'left' }, viewport);
    const pan = buildGesturePlan({ intent: 'pan', preset: 'right', durationMs: 400 }, viewport);

    assert.deepEqual(fling.pointers[0].samples[0]?.point, { x: 360, y: 430 });
    assert.deepEqual(fling.pointers[0].samples.at(-1)?.point, { x: 80, y: 430 });
    assert.equal(pan.durationMs, 400);
    assert.deepEqual(pan.pointers[0].samples[0]?.point, { x: 80, y: 430 });
    assert.deepEqual(pan.pointers[0].samples.at(-1)?.point, { x: 360, y: 430 });
  });
});

describe('two-pointer plans', () => {
  test('rejects finite rotations that overflow generated coordinates', () => {
    assert.throws(
      () => buildGesturePlan({ intent: 'rotate', degrees: Number.MAX_VALUE }, PORTRAIT),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INVALID_ARGS' &&
        error.message === 'Gesture motion produces non-finite pointer coordinates' &&
        'details' in error &&
        (error.details as { reason?: string }).reason === 'GESTURE_TRAJECTORY_NON_FINITE',
    );
  });

  test('two-finger pan moves in parallel with constant span and angle', () => {
    const plan = requireTwoPointerPlan(
      buildGesturePlan(
        {
          intent: 'pan',
          pointerCount: 2,
          origin: { x: 195, y: 422 },
          delta: { x: 60, y: -30 },
          durationMs: 500,
        },
        PORTRAIT,
      ),
    );
    const span = initialSpan(plan);
    assert.equal(plan.intent, 'pan');
    for (let index = 0; index < plan.pointers[0].samples.length; index += 1) {
      const first = requiredPoint(plan.pointers[0].samples[index]?.point);
      const second = requiredPoint(plan.pointers[1].samples[index]?.point);
      assert.ok(Math.abs(distance(first, second) - span) < 1e-8);
      assert.ok(Math.abs(normalizedAngle(first, second) - 90) < 1e-8);
    }
    assert.deepEqual(centroid(plan, -1), { x: 255, y: 392 });
  });

  test('pinch constrains translation and rotation', () => {
    for (const scale of [0.5, 2]) {
      const plan = requireTwoPointerPlan(buildGesturePlan({ intent: 'pinch', scale }, PORTRAIT));
      assert.deepEqual(centroid(plan, 0), centroid(plan, -1));
      assert.ok(Math.abs(finalSpan(plan) / initialSpan(plan) - scale) < 1e-8);
      assert.ok(Math.abs(rotationDelta(plan)) < 1e-8);
    }
  });

  test('rotate constrains translation and scale', () => {
    for (const degrees of [-45, 45]) {
      const plan = requireTwoPointerPlan(
        buildGesturePlan({ intent: 'rotate', degrees }, LANDSCAPE),
      );
      assert.deepEqual(centroid(plan, 0), centroid(plan, -1));
      assert.ok(Math.abs(finalSpan(plan) - initialSpan(plan)) < 1e-8);
      assert.ok(Math.abs(rotationDelta(plan) - degrees) < 1e-8);
    }
  });

  test('transform progresses every component atomically', () => {
    const plan = requireTwoPointerPlan(
      buildGesturePlan(
        {
          intent: 'transform',
          origin: { x: 200, y: 400 },
          delta: { x: -80, y: 40 },
          scale: 1.5,
          degrees: 36,
          durationMs: 640,
        },
        PORTRAIT,
      ),
    );
    const midpointIndex = plan.pointers[0].samples.findIndex(({ offsetMs }) => offsetMs === 320);
    const midpoint = centroid(plan, midpointIndex);
    const midpointSpan = distance(
      requiredPoint(plan.pointers[0].samples[midpointIndex]?.point),
      requiredPoint(plan.pointers[1].samples[midpointIndex]?.point),
    );
    assert.deepEqual(midpoint, { x: 160, y: 420 });
    assert.ok(Math.abs(midpointSpan / initialSpan(plan) - 1.25) < 1e-8);
    assert.ok(Math.abs(rotationDeltaThrough(plan, midpointIndex) - 18) < 1e-8);
    assert.deepEqual(centroid(plan, -1), { x: 120, y: 440 });
    assert.ok(Math.abs(finalSpan(plan) / initialSpan(plan) - 1.5) < 1e-8);
    assert.ok(Math.abs(rotationDelta(plan) - 36) < 1e-8);
  });

  test('initial geometry is deterministic and viewport-relative', () => {
    for (const viewport of [PORTRAIT, LANDSCAPE]) {
      const plan = requireTwoPointerPlan(buildGesturePlan({ intent: 'pinch', scale: 1 }, viewport));
      assert.equal(initialSpan(plan), Math.min(viewport.width, viewport.height) * 0.4);
      assert.ok(
        Math.abs(
          normalizedAngle(
            requiredPoint(plan.pointers[0].samples[0]?.point),
            requiredPoint(plan.pointers[1].samples[0]?.point),
          ) - Math.abs(GESTURE_INITIAL_ANGLE_DEGREES),
        ) < 1e-8,
      );
    }

    const androidPinch = requireTwoPointerPlan(
      buildGesturePlan({ intent: 'pinch', scale: 1 }, PORTRAIT, 'android'),
    );
    assert.ok(
      Math.abs(
        normalizedAngle(
          requiredPoint(androidPinch.pointers[0].samples[0]?.point),
          requiredPoint(androidPinch.pointers[1].samples[0]?.point),
        ),
      ) < 1e-8,
    );
    assert.equal(androidPinch.pointers[0].samples[1]?.offsetMs, 16);
    assert.equal(
      requireTwoPointerPlan(buildGesturePlan({ intent: 'pinch', scale: 1 }, PORTRAIT, 'ios'))
        .pointers[0].samples[1]?.offsetMs,
      17,
    );
  });
});

test('invalid and non-finite values fail before execution', () => {
  const cases = [
    () =>
      buildGesturePlan(
        { intent: 'pan', origin: { x: NaN, y: 1 }, delta: { x: 1, y: 1 } },
        PORTRAIT,
      ),
    () =>
      buildGesturePlan(
        { intent: 'pan', origin: { x: 100, y: 100 }, delta: { x: 1, y: 1 }, pointerCount: 3 as 1 },
        PORTRAIT,
      ),
    () => buildGesturePlan({ intent: 'pinch', scale: Infinity }, PORTRAIT),
    () => buildGesturePlan({ intent: 'rotate', degrees: NaN }, PORTRAIT),
    () =>
      buildGesturePlan(
        {
          intent: 'transform',
          origin: { x: 100, y: 100 },
          delta: { x: 1, y: 1 },
          scale: 0,
          degrees: 0,
        },
        PORTRAIT,
      ),
  ];
  for (const run of cases) assert.throws(run, /finite|greater than 0|must be 1 or 2/);
});

function rotationDeltaThrough(plan: Parameters<typeof rotationDelta>[0], index: number): number {
  const start = Math.atan2(
    requiredPoint(plan.pointers[0].samples[0]?.point).y -
      requiredPoint(plan.pointers[1].samples[0]?.point).y,
    requiredPoint(plan.pointers[0].samples[0]?.point).x -
      requiredPoint(plan.pointers[1].samples[0]?.point).x,
  );
  const end = Math.atan2(
    requiredPoint(plan.pointers[0].samples[index]?.point).y -
      requiredPoint(plan.pointers[1].samples[index]?.point).y,
    requiredPoint(plan.pointers[0].samples[index]?.point).x -
      requiredPoint(plan.pointers[1].samples[index]?.point).x,
  );
  return ((end - start) * 180) / Math.PI;
}
