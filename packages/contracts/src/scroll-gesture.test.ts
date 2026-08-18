import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertScrollGestureInput,
  buildInPageSwipeGesturePlan,
  buildScrollGesturePlan,
  clampGestureCoordinate,
} from './scroll-gesture.ts';

test('buildInPageSwipeGesturePlan applies one inset lane policy in every direction', () => {
  const frame = { referenceWidth: 400, referenceHeight: 800 };

  assert.deepEqual(buildInPageSwipeGesturePlan('left', frame), {
    direction: 'left',
    x1: 340,
    y1: 400,
    x2: 60,
    y2: 400,
    ...frame,
  });
  assert.deepEqual(buildInPageSwipeGesturePlan('down', frame), {
    direction: 'down',
    x1: 200,
    y1: 120,
    x2: 200,
    y2: 680,
    ...frame,
  });
});

test('buildInPageSwipeGesturePlan truncates percentage coordinates on odd viewports', () => {
  assert.deepEqual(
    buildInPageSwipeGesturePlan('left', { referenceWidth: 401, referenceHeight: 801 }),
    {
      direction: 'left',
      x1: 340,
      y1: 400,
      x2: 60,
      y2: 400,
      referenceWidth: 401,
      referenceHeight: 801,
    },
  );
});

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
    y1: 720,
    x2: 200,
    y2: 80,
    referenceWidth: 400,
    referenceHeight: 800,
    amount: 2,
    pixels: 640,
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
    y1: 720,
    x2: 200,
    y2: 80,
    referenceWidth: 400,
    referenceHeight: 800,
    amount: undefined,
    pixels: 640,
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

  assert.equal(plan.x1, 270);
  assert.equal(plan.x2, 30);
  assert.equal(plan.y1, 300);
  assert.equal(plan.y2, 300);
  assert.equal(plan.pixels, 240);
});

// #1781 A1: an edge-to-edge app window includes the status bar, so a saturated `scroll up` used
// to start inside it (y=120 on a Pixel 7, whose cutout status bar is 136px tall) and pulled the
// notification shade down instead of scrolling. The band keeps the touch-down below the bar.
test('buildScrollGesturePlan keeps a saturated scroll up out of a Pixel 7 status bar', () => {
  const plan = buildScrollGesturePlan({
    direction: 'up',
    amount: 3,
    referenceWidth: 1080,
    referenceHeight: 2400,
  });

  assert.equal(plan.y1, 240);
  assert.equal(plan.y2, 2160);
  assert.ok(plan.y1 > 136, `touch-down y=${plan.y1} must clear the 136px status bar`);
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

test('clampGestureCoordinate rounds values and clamps them into the safe gesture band', () => {
  assert.equal(clampGestureCoordinate(10.4, 8, 100), 10);
  assert.equal(clampGestureCoordinate(10.6, 8, 100), 11);
  assert.equal(clampGestureCoordinate(2.6, 8, 100), 8);
  assert.equal(clampGestureCoordinate(97.6, 8, 100), 92);
});

test('clampGestureCoordinate returns the lower bound for non-finite coordinates', () => {
  assert.equal(clampGestureCoordinate(Number.POSITIVE_INFINITY, 8, 100), 8);
});
