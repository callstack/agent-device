import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../kernel/errors.ts';
import {
  assertScrollGestureInput,
  buildScrollGesturePlan,
  buildSwipeGesturePlan,
  clampGestureCoordinate,
  pointFromPercent,
} from '../scroll-gesture.ts';

// The buildScrollGesturePlan vectors below are the canonical cross-language parity vectors,
// mirrored by RunnerTests+ScrollGesture.swift (runnerScrollGesturePlan). If you change the scroll
// math, update both this suite and the Swift parity test so the two ports cannot drift silently.
test('buildScrollGesturePlan maps relative amount to viewport travel', () => {
  const plan = buildScrollGesturePlan({
    direction: 'down',
    amount: 0.5,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  assert.deepEqual(plan, {
    direction: 'down',
    x1: 200,
    y1: 600,
    x2: 200,
    y2: 200,
    referenceWidth: 400,
    referenceHeight: 800,
    amount: 0.5,
    pixels: 400,
  });
});

test('buildScrollGesturePlan maps explicit pixels below the safe band cap', () => {
  const plan = buildScrollGesturePlan({
    direction: 'down',
    pixels: 120,
    referenceWidth: 300,
    referenceHeight: 600,
  });

  assert.deepEqual(plan, {
    direction: 'down',
    x1: 150,
    y1: 360,
    x2: 150,
    y2: 240,
    referenceWidth: 300,
    referenceHeight: 600,
    amount: undefined,
    pixels: 120,
  });
});

test('buildScrollGesturePlan clamps amounts above 1 to the safe gesture band', () => {
  const plan = buildScrollGesturePlan({
    direction: 'down',
    amount: 2,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  assert.deepEqual(plan, {
    direction: 'down',
    x1: 200,
    y1: 760,
    x2: 200,
    y2: 40,
    referenceWidth: 400,
    referenceHeight: 800,
    amount: 2,
    pixels: 720,
  });
});

test('buildScrollGesturePlan clamps explicit pixel travel to the vertical safe gesture band', () => {
  const plan = buildScrollGesturePlan({
    direction: 'down',
    pixels: 1000,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  assert.deepEqual(plan, {
    direction: 'down',
    x1: 200,
    y1: 760,
    x2: 200,
    y2: 40,
    referenceWidth: 400,
    referenceHeight: 800,
    amount: undefined,
    pixels: 720,
  });
});

test('buildScrollGesturePlan floors padding and travel on tiny frames', () => {
  // 2x2 engages every max(1, ...) floor and the .5 rounding cases the two ports must agree on
  // (halfTravel 0.5 -> 1, center 1 from 2/2).
  const plan = buildScrollGesturePlan({
    direction: 'down',
    pixels: 10,
    referenceWidth: 2,
    referenceHeight: 2,
  });

  assert.deepEqual(plan, {
    direction: 'down',
    x1: 1,
    y1: 2,
    x2: 1,
    y2: 0,
    referenceWidth: 2,
    referenceHeight: 2,
    amount: undefined,
    pixels: 1,
  });
});

test('buildScrollGesturePlan clamps pixel travel to the safe gesture band', () => {
  const plan = buildScrollGesturePlan({
    direction: 'right',
    pixels: 500,
    referenceWidth: 300,
    referenceHeight: 600,
  });

  assert.equal(plan.x1, 285);
  assert.equal(plan.x2, 15);
  assert.equal(plan.y1, 300);
  assert.equal(plan.y2, 300);
  assert.equal(plan.pixels, 270);
});

test('buildScrollGesturePlan rejects invalid amounts', () => {
  assert.throws(
    () =>
      buildScrollGesturePlan({
        direction: 'down',
        amount: 0,
        referenceWidth: 400,
        referenceHeight: 800,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /amount must be a positive number/i.test(error.message),
  );
});

test('assertScrollGestureInput accepts valid amount and pixels inputs', () => {
  assert.doesNotThrow(() => assertScrollGestureInput({}));
  assert.doesNotThrow(() => assertScrollGestureInput({ amount: 0.5 }));
  assert.doesNotThrow(() => assertScrollGestureInput({ pixels: 120 }));
});

test('assertScrollGestureInput rejects non-positive or non-finite amounts', () => {
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assertScrollGestureInput({ amount }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /amount must be a positive number/i.test(error.message),
    );
  }
});

test('assertScrollGestureInput rejects non-positive or non-finite pixels', () => {
  for (const pixels of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assertScrollGestureInput({ pixels }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /pixels must be a positive integer/i.test(error.message),
    );
  }
});

test('buildSwipeGesturePlan maps finger direction through the shared scroll planner', () => {
  const plan = buildSwipeGesturePlan({
    direction: 'left',
    amount: 0.6,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  assert.deepEqual(plan, {
    direction: 'left',
    x1: 320,
    y1: 400,
    x2: 80,
    y2: 400,
    referenceWidth: 400,
    referenceHeight: 800,
    amount: 0.6,
    pixels: 240,
  });
});

test('pointFromPercent preserves unclamped percentages and clamps when a margin is requested', () => {
  const frame = { referenceWidth: 400, referenceHeight: 800 };

  assert.deepEqual(pointFromPercent(frame, 125, -10), { x: 500, y: -80 });
  assert.deepEqual(pointFromPercent(frame, 100, 0, { marginPx: 8 }), { x: 392, y: 8 });
});

test('clampGestureCoordinate rounds values and clamps them into the safe gesture band', () => {
  assert.equal(clampGestureCoordinate(10.4, 8, 100), 10);
  assert.equal(clampGestureCoordinate(10.6, 8, 100), 11);
  assert.equal(clampGestureCoordinate(2.6, 8, 100), 8);
  assert.equal(clampGestureCoordinate(97.6, 8, 100), 92);
});
