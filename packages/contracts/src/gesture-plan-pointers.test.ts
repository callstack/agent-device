import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { GESTURE_INITIAL_ANGLE_DEGREES, buildGesturePlan } from './gesture-plan.ts';
import {
  centroid,
  distance,
  finalSpan,
  initialSpan,
  isErrorWithReason,
  LANDSCAPE,
  normalizedAngle,
  PORTRAIT,
  requiredPoint,
  requireTwoPointerPlan,
  rotationDelta,
} from './gesture-plan.fixtures.ts';

describe('single-pointer plans', () => {
  test('pan defaults to one pointer and preserves endpoints and duration', () => {
    const plan = buildGesturePlan(
      { intent: 'pan', origin: { x: 100, y: 200 }, delta: { x: -40, y: 25 } },
      PORTRAIT,
    );
    assert.equal(plan.topology, 'single');
    assert.equal(plan.intent, 'pan');
    assert.equal(plan.executionProfile, 'timed-pan');
    assert.equal(plan.durationMs, 500);
    assert.deepEqual(plan.pointers[0].samples[0]?.point, { x: 100, y: 200 });
    assert.deepEqual(plan.pointers[0].samples.at(-1)?.point, { x: 60, y: 225 });
    assert.deepEqual(
      plan.pointers[0].samples.map(({ offsetMs }) => offsetMs),
      [0, 500],
    );
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
    assert.equal(directional.topology, 'single');
    assert.equal(endpoints.topology, 'single');
    assert.equal(directional.durationMs, 100);
    assert.equal(endpoints.durationMs, 100);
    assert.equal(directional.executionProfile, 'endpoint-hold');
    assert.equal(endpoints.executionProfile, 'endpoint-hold');
    assert.deepEqual(directional.pointers[0].samples.at(-1)?.point, { x: 50, y: 20 });
    assert.deepEqual(endpoints.pointers[0].samples.at(-1)?.point, { x: 230, y: 100 });
  });

  test('planner resolves swipe presets inside the active viewport', () => {
    const viewport = { x: 20, y: 30, width: 400, height: 800 };
    const leftFling = buildGesturePlan({ intent: 'fling', preset: 'left' }, viewport);
    const rightFling = buildGesturePlan({ intent: 'fling', preset: 'right' }, viewport);

    assert.deepEqual(leftFling.pointers[0].samples[0]?.point, { x: 360, y: 430 });
    assert.deepEqual(leftFling.pointers[0].samples.at(-1)?.point, { x: 80, y: 430 });
    assert.equal(rightFling.durationMs, 100);
    assert.deepEqual(rightFling.pointers[0].samples[0]?.point, { x: 80, y: 430 });
    assert.deepEqual(rightFling.pointers[0].samples.at(-1)?.point, { x: 360, y: 430 });
  });

  test('single-pointer pan preserves its execution profile', () => {
    const plan = buildGesturePlan(
      {
        intent: 'pan',
        origin: { x: 360, y: 430 },
        delta: { x: -320, y: 0 },
        durationMs: 500,
        executionProfile: 'endpoint-hold',
      },
      PORTRAIT,
    );

    assert.equal(plan.topology, 'single');
    assert.equal(plan.intent, 'pan');
    assert.equal(plan.executionProfile, 'endpoint-hold');
    assert.equal(plan.durationMs, 500);
    assert.deepEqual(plan.pointers[0].samples[0]?.point, { x: 360, y: 430 });
    assert.deepEqual(plan.pointers[0].samples.at(-1)?.point, { x: 40, y: 430 });
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
        { intent: 'pan', origin: { x: Number.NaN, y: 1 }, delta: { x: 1, y: 1 } },
        PORTRAIT,
      ),
    () =>
      buildGesturePlan(
        { intent: 'pan', origin: { x: 100, y: 100 }, delta: { x: 1, y: 1 }, pointerCount: 3 as 1 },
        PORTRAIT,
      ),
    () => buildGesturePlan({ intent: 'pinch', scale: Infinity }, PORTRAIT),
    () => buildGesturePlan({ intent: 'rotate', degrees: Number.NaN }, PORTRAIT),
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

describe('multi-finger tap plans', () => {
  test('touches every point at once and lifts them together after the hold', () => {
    const plan = buildGesturePlan(
      {
        intent: 'tap',
        points: [
          { x: 80, y: 300 },
          { x: 200, y: 450 },
          { x: 310, y: 600 },
          { x: 120, y: 700 },
          { x: 260, y: 200 },
        ],
        holdMs: 60,
      },
      PORTRAIT,
    );
    assert.equal(plan.topology, 'multi');
    assert.equal(plan.intent, 'tap');
    assert.equal(plan.durationMs, 60);
    assert.deepEqual(plan.pointers, [
      { pointerId: 0, samples: [sample(0, 80, 300), sample(60, 80, 300)] },
      { pointerId: 1, samples: [sample(0, 200, 450), sample(60, 200, 450)] },
      { pointerId: 2, samples: [sample(0, 310, 600), sample(60, 310, 600)] },
      { pointerId: 3, samples: [sample(0, 120, 700), sample(60, 120, 700)] },
      { pointerId: 4, samples: [sample(0, 260, 200), sample(60, 260, 200)] },
    ]);
  });

  test('holds for 50 ms when no hold is given', () => {
    const plan = buildGesturePlan(
      {
        intent: 'tap',
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 100 },
        ],
      },
      PORTRAIT,
    );
    assert.equal(plan.durationMs, 50);
  });

  test('refuses one point and six points, accepting two and five', () => {
    const points = [100, 140, 180, 220, 260, 300].map((x) => ({ x, y: 400 }));
    for (const count of [1, 6]) {
      assert.throws(
        () => buildGesturePlan({ intent: 'tap', points: points.slice(0, count) }, PORTRAIT),
        { code: 'INVALID_ARGS', message: 'gesture tap requires 2 to 5 points' },
      );
    }
    for (const count of [2, 5]) {
      assert.equal(
        buildGesturePlan({ intent: 'tap', points: points.slice(0, count) }, PORTRAIT).pointers
          .length,
        count,
      );
    }
  });

  test('refuses two contacts on the same point but not two points one unit apart', () => {
    assert.throws(
      () =>
        buildGesturePlan(
          {
            intent: 'tap',
            points: [
              { x: 100, y: 100 },
              { x: 150, y: 100 },
              { x: 100, y: 100 },
            ],
          },
          PORTRAIT,
        ),
      (error: unknown) => isErrorWithReason(error, 'INVALID_ARGS', 'GESTURE_TAP_DUPLICATE_POINT'),
    );
    assert.equal(
      buildGesturePlan(
        {
          intent: 'tap',
          points: [
            { x: 100, y: 100 },
            { x: 101, y: 100 },
          ],
        },
        PORTRAIT,
      ).pointers.length,
      2,
    );
  });

  test('refuses a point outside the viewport', () => {
    assert.throws(
      () =>
        buildGesturePlan(
          {
            intent: 'tap',
            points: [
              { x: 100, y: 100 },
              { x: 391, y: 100 },
            ],
          },
          PORTRAIT,
        ),
      (error: unknown) =>
        isErrorWithReason(error, 'INVALID_ARGS', 'GESTURE_TRAJECTORY_OUT_OF_BOUNDS'),
    );
  });
});

function sample(offsetMs: number, x: number, y: number) {
  return { offsetMs, point: { x, y } };
}
