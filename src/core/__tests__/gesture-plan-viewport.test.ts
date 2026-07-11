import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { buildGesturePlan, GESTURE_SAMPLE_INTERVAL_MS } from '../../contracts/gesture-plan.ts';
import {
  assertAllSamplesInViewport,
  isErrorWithReason,
  LANDSCAPE,
  PORTRAIT,
  requireTwoPointerPlan,
} from './gesture-plan-test-utils.ts';

describe('viewport-aware multi-touch geometry', () => {
  test.each([
    ['portrait center', PORTRAIT, { x: 195, y: 422 }],
    ['landscape center', LANDSCAPE, { x: 422, y: 195 }],
  ])('%s keeps every positive/negative rotation sample in bounds', (_name, viewport, origin) => {
    for (const degrees of [-60, 60]) {
      const plan = requireTwoPointerPlan(
        buildGesturePlan(
          {
            intent: 'transform',
            origin,
            delta: { x: 0, y: 0 },
            scale: 1,
            degrees,
            durationMs: 300,
          },
          viewport,
        ),
      );
      assertAllSamplesInViewport(plan);
    }
  });

  test.each([
    ['top-left', PORTRAIT, { x: 30, y: 30 }],
    ['top-right', PORTRAIT, { x: 360, y: 30 }],
    ['bottom-left', PORTRAIT, { x: 30, y: 814 }],
    ['bottom-right', PORTRAIT, { x: 360, y: 814 }],
    ['top edge', PORTRAIT, { x: 195, y: 30 }],
    ['bottom edge', PORTRAIT, { x: 195, y: 814 }],
    ['left edge', PORTRAIT, { x: 30, y: 422 }],
    ['right edge', PORTRAIT, { x: 360, y: 422 }],
  ])('%s fails instead of shrinking the requested pointer geometry', (_name, viewport, origin) => {
    assert.throws(
      () =>
        buildGesturePlan(
          {
            intent: 'transform',
            origin,
            delta: { x: 0, y: 0 },
            scale: 1,
            degrees: 60,
            durationMs: 300,
          },
          viewport,
        ),
      (error: unknown) =>
        isErrorWithReason(error, 'INVALID_ARGS', 'GESTURE_TRAJECTORY_OUT_OF_BOUNDS'),
    );
  });

  test('single-pointer trajectories also fail outside the active viewport', () => {
    for (const [origin, delta] of [
      [
        { x: 0, y: 100 },
        { x: 20, y: 0 },
      ],
      [
        { x: 200, y: 100 },
        { x: 300, y: 0 },
      ],
    ] as const) {
      assert.throws(
        () => buildGesturePlan({ intent: 'pan', origin, delta }, PORTRAIT),
        (error: unknown) =>
          isErrorWithReason(error, 'INVALID_ARGS', 'GESTURE_TRAJECTORY_OUT_OF_BOUNDS'),
      );
    }
  });

  test('positive and negative translation choose geometry that keeps the full path in bounds', () => {
    for (const delta of [
      { x: 80, y: 40 },
      { x: -80, y: -40 },
    ]) {
      const plan = requireTwoPointerPlan(
        buildGesturePlan(
          {
            intent: 'transform',
            origin: { x: 195, y: 422 },
            delta,
            scale: 1.4,
            degrees: -30,
            durationMs: 640,
          },
          PORTRAIT,
        ),
      );
      assertAllSamplesInViewport(plan);
    }
  });

  test('very small and impossible trajectories fail early with structured recovery details', () => {
    for (const [viewport, origin, delta] of [
      [
        { x: 0, y: 0, width: 40, height: 40 },
        { x: 20, y: 20 },
        { x: 0, y: 0 },
      ],
      [PORTRAIT, { x: 195, y: 422 }, { x: 300, y: 0 }],
    ] as const) {
      assert.throws(
        () =>
          buildGesturePlan(
            {
              intent: 'transform',
              origin,
              delta,
              scale: 1,
              degrees: 0,
            },
            viewport,
          ),
        (error: unknown) =>
          isErrorWithReason(error, 'INVALID_ARGS', 'GESTURE_TRAJECTORY_OUT_OF_BOUNDS'),
      );
    }
  });

  test('sample cadence is deterministic for short and long durations', () => {
    const short = buildTransformPlan(16);
    const long = buildTransformPlan(10_000);

    assert.deepEqual(
      short.pointers[0].samples.map((sample) => sample.offsetMs),
      [0, 5, 11, 16],
    );
    assert.equal(long.pointers[0].samples.length, 626);
    assert.equal(long.pointers[0].samples.at(-1)?.offsetMs, 10_000);
    assert.equal(long.pointers[0].samples[1]?.offsetMs, GESTURE_SAMPLE_INTERVAL_MS);
  });
});

function buildTransformPlan(durationMs: number) {
  return requireTwoPointerPlan(
    buildGesturePlan(
      {
        intent: 'transform',
        origin: { x: 195, y: 422 },
        delta: { x: 10, y: 0 },
        scale: 1.1,
        degrees: 5,
        durationMs,
      },
      PORTRAIT,
    ),
  );
}
