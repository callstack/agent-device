import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { buildGesturePlan, GESTURE_INITIAL_ANGLE_DEGREES } from '../gesture-plan.ts';
import {
  distance,
  finalSpan,
  LANDSCAPE,
  normalizedAngle,
  PORTRAIT,
  requiredPoint,
  requireTwoPointerPlan,
  rotationDelta,
} from './gesture-plan-test-utils.ts';

describe('single-pointer gesture plans', () => {
  test('pan defaults to one pointer and preserves the shipped duration and endpoints', () => {
    const plan = buildGesturePlan({
      intent: 'pan',
      origin: { x: 100, y: 200 },
      delta: { x: -40, y: 25 },
    });

    assert.equal(plan.topology, 'single');
    assert.equal(plan.intent, 'pan');
    assert.equal(plan.durationMs, 500);
    assert.deepEqual(plan.pointers[0].samples[0], {
      offsetMs: 0,
      point: { x: 100, y: 200 },
    });
    assert.deepEqual(plan.pointers[0].samples.at(-1), {
      offsetMs: 500,
      point: { x: 60, y: 225 },
    });
  });

  test('explicit swipe plans do not require a viewport', () => {
    const plan = buildGesturePlan({
      intent: 'swipe',
      from: { x: 20, y: 30 },
      to: { x: 220, y: 30 },
      durationMs: 16,
    });

    assert.equal(plan.topology, 'single');
    assert.equal(plan.durationMs, 16);
    assert.deepEqual(
      plan.pointers[0].samples.map((sample) => sample.offsetMs),
      [0, 16],
    );
  });

  test('preset swipe uses the supplied viewport origin and lane', () => {
    const plan = buildGesturePlan(
      { intent: 'swipe', preset: 'left', durationMs: 400 },
      { x: 10, y: 20, width: 200, height: 400 },
    );

    assert.equal(plan.topology, 'single');
    assert.deepEqual(plan.pointers[0].samples[0]?.point, { x: 180, y: 220 });
    assert.deepEqual(plan.pointers[0].samples.at(-1)?.point, { x: 40, y: 220 });
  });

  test('fling preserves direction, distance, and short/long duration bounds', () => {
    const short = buildGesturePlan({
      intent: 'fling',
      direction: 'up',
      origin: { x: 50, y: 100 },
      distance: 80,
      durationMs: 16,
    });
    const long = buildGesturePlan({
      intent: 'fling',
      direction: 'right',
      origin: { x: 50, y: 100 },
      durationMs: 1_000,
    });

    assert.deepEqual(short.pointers[0].samples.at(-1)?.point, { x: 50, y: 20 });
    assert.deepEqual(long.pointers[0].samples.at(-1)?.point, { x: 230, y: 100 });
    assert.throws(
      () =>
        buildGesturePlan({
          intent: 'fling',
          direction: 'right',
          origin: { x: 0, y: 0 },
          durationMs: 1_001,
        }),
      /between 16 and 1000/,
    );
  });
});

describe('two-pointer semantic normalization', () => {
  test('two-finger pan keeps span and angle constant while both pointers translate in parallel', () => {
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

    assert.equal(plan.intent, 'pan');
    assert.equal(plan.scale, 1);
    assert.equal(plan.rotationDegrees, 0);
    assert.equal(plan.initialAngleDegrees, GESTURE_INITIAL_ANGLE_DEGREES);
    for (let index = 0; index < plan.pointers[0].samples.length; index += 1) {
      const first = requiredPoint(plan.pointers[0].samples[index]?.point);
      const second = requiredPoint(plan.pointers[1].samples[index]?.point);
      assert.ok(Math.abs(distance(first, second) - plan.initialSpan) < 1e-8);
      assert.ok(Math.abs(normalizedAngle(first, second) - 90) < 1e-8);
    }
    assert.deepEqual(plan.centroid.end, { x: 255, y: 392 });
  });

  test('pinch fixes translation and rotation while preserving requested scale in and out', () => {
    for (const scale of [0.5, 2]) {
      const plan = requireTwoPointerPlan(buildGesturePlan({ intent: 'pinch', scale }, PORTRAIT));
      assert.equal(plan.intent, 'pinch');
      assert.deepEqual(plan.centroid.start, plan.centroid.end);
      assert.equal(plan.rotationDegrees, 0);
      assert.ok(Math.abs(finalSpan(plan) / plan.initialSpan - scale) < 1e-8);
    }
  });

  test('rotate fixes translation and scale and normalizes velocity sign to rotation', () => {
    const clockwise = requireTwoPointerPlan(
      buildGesturePlan({ intent: 'rotate', degrees: 45, velocity: -4 }, LANDSCAPE),
    );
    const counterClockwise = requireTwoPointerPlan(
      buildGesturePlan({ intent: 'rotate', degrees: -45, velocity: 4 }, LANDSCAPE),
    );
    const defaultVelocity = requireTwoPointerPlan(
      buildGesturePlan({ intent: 'rotate', degrees: -45 }, LANDSCAPE),
    );

    for (const plan of [clockwise, counterClockwise]) {
      assert.deepEqual(plan.centroid.start, plan.centroid.end);
      assert.equal(plan.scale, 1);
    }
    assert.equal(clockwise.velocity, 4);
    assert.equal(counterClockwise.velocity, -4);
    assert.equal(defaultVelocity.velocity, -1);
    assert.ok(Math.abs(rotationDelta(clockwise) - 45) < 1e-8);
    assert.ok(Math.abs(rotationDelta(counterClockwise) + 45) < 1e-8);
  });

  test('transform applies translation, scale, and rotation atomically', () => {
    const plan = requireTwoPointerPlan(
      buildGesturePlan(
        {
          intent: 'transform',
          origin: { x: 200, y: 400 },
          delta: { x: -80, y: 40 },
          scale: 1.5,
          degrees: 35,
          durationMs: 700,
        },
        PORTRAIT,
      ),
    );

    assert.equal(plan.intent, 'transform');
    assert.deepEqual(plan.centroid.end, { x: 120, y: 440 });
    assert.ok(Math.abs(finalSpan(plan) / plan.initialSpan - 1.5) < 1e-8);
    assert.ok(Math.abs(rotationDelta(plan) - 35) < 1e-8);
    assert.deepEqual(plan.pointers[0].samples.at(-1)?.offsetMs, 700);
  });

  test('zero transform remains a valid stationary two-pointer trajectory', () => {
    const plan = requireTwoPointerPlan(
      buildGesturePlan(
        {
          intent: 'transform',
          origin: { x: 195, y: 422 },
          delta: { x: 0, y: 0 },
          scale: 1,
          degrees: 0,
        },
        PORTRAIT,
      ),
    );
    assert.deepEqual(plan.pointers[0].samples[0]?.point, plan.pointers[0].samples.at(-1)?.point);
    assert.deepEqual(plan.pointers[1].samples[0]?.point, plan.pointers[1].samples.at(-1)?.point);
  });
});

test('invalid and non-finite semantic values never reach a platform adapter', () => {
  const cases = [
    () => buildGesturePlan({ intent: 'pan', origin: { x: NaN, y: 1 }, delta: { x: 1, y: 1 } }),
    () =>
      buildGesturePlan({
        intent: 'pan',
        origin: { x: 1, y: 1 },
        delta: { x: 1, y: 1 },
        pointerCount: 3 as 1,
      }),
    () =>
      buildGesturePlan({
        intent: 'fling',
        direction: 'up',
        origin: { x: 1, y: 1 },
        distance: Infinity,
      }),
    () => buildGesturePlan({ intent: 'pinch', scale: Infinity }, PORTRAIT),
    () => buildGesturePlan({ intent: 'rotate', degrees: NaN }, PORTRAIT),
    () =>
      buildGesturePlan(
        {
          intent: 'transform',
          origin: { x: 1, y: 1 },
          delta: { x: 1, y: 1 },
          scale: 0,
          degrees: 0,
        },
        PORTRAIT,
      ),
    () =>
      buildGesturePlan(
        {
          intent: 'transform',
          origin: { x: 1, y: 1 },
          delta: { x: 1, y: 1 },
          scale: 1,
          degrees: Infinity,
        },
        PORTRAIT,
      ),
  ];
  for (const run of cases) assert.throws(run, /finite|greater than 0|must be 1 or 2/);
});
