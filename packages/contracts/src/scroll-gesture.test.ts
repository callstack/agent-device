import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertScrollGestureInput,
  buildInPageSwipeGesturePlan,
  buildScrollGesturePlan,
  clampGestureCoordinate,
} from './scroll-gesture.ts';
import {
  DEFAULT_IOS_SCROLL_AMOUNT,
  DEFAULT_IOS_SCROLL_DURATION_MS,
  DEFAULT_MOBILE_SCROLL_DURATION_MS,
  resolveScrollExecutionOptions,
} from './scroll-command.ts';

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

// Cross-language parity table: every case in contracts/fixtures/scroll-gesture.json is asserted
// here AND by the Swift port (runnerScrollGesturePlan in RunnerTests+ScrollGesture.swift, gated
// XCTest in the same file). Add vectors to the table, never to one suite — drift on either side
// turns CI red without a simulator.
type ScrollGestureFixture = {
  constants: {
    defaultIosScrollAmount: number;
    defaultMobileScrollDurationMs: number;
    defaultIosScrollDurationMs: number;
    defaultScrollAmount: number;
    defaultEdgePaddingFraction: number;
    ordinaryScrollReleaseBehavior: 'controlled';
    edgeScrollReleaseBehavior: 'inertial';
  };
  cases: Array<{
    name: string;
    direction: 'up' | 'down' | 'left' | 'right';
    amount?: number;
    pixels?: number;
    referenceWidth: number;
    referenceHeight: number;
    expected: { x1: number; y1: number; x2: number; y2: number; pixels: number };
  }>;
};

const SCROLL_TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'scroll-gesture.json',
);

function readScrollGestureFixture(): ScrollGestureFixture {
  return JSON.parse(fs.readFileSync(SCROLL_TABLE_PATH, 'utf8')) as ScrollGestureFixture;
}

test('buildScrollGesturePlan agrees with every scroll-gesture parity table case', () => {
  const { cases } = readScrollGestureFixture();
  assert.ok(cases.length > 0, 'parity table must not be empty');
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length, 'case names must be unique');
  for (const fixture of cases) {
    const plan = buildScrollGesturePlan({
      direction: fixture.direction,
      amount: fixture.amount,
      pixels: fixture.pixels,
      referenceWidth: fixture.referenceWidth,
      referenceHeight: fixture.referenceHeight,
    });
    assert.deepEqual(
      { x1: plan.x1, y1: plan.y1, x2: plan.x2, y2: plan.y2, pixels: plan.pixels },
      fixture.expected,
      fixture.name,
    );
    assert.equal(plan.direction, fixture.direction, fixture.name);
    assert.equal(plan.amount, fixture.amount, fixture.name);
    assert.equal(plan.referenceWidth, fixture.referenceWidth, fixture.name);
    assert.equal(plan.referenceHeight, fixture.referenceHeight, fixture.name);
  }
});

// The two planner constants are private on both sides; the table pins them behaviourally on a
// 1000px axis where every rounding step is exact.
test('buildScrollGesturePlan uses the parity table default amount and edge padding', () => {
  const { constants } = readScrollGestureFixture();
  const frame = { referenceWidth: 1000, referenceHeight: 1000 };
  const defaulted = buildScrollGesturePlan({ direction: 'down', ...frame });
  assert.equal(defaulted.pixels, 1000 * constants.defaultScrollAmount);
  const saturated = buildScrollGesturePlan({ direction: 'down', amount: 10, ...frame });
  assert.equal(saturated.pixels, 1000 - 2 * 1000 * constants.defaultEdgePaddingFraction);
});

test('mobile scroll duration agrees with the cross-platform parity table', () => {
  const { constants } = readScrollGestureFixture();
  assert.equal(DEFAULT_IOS_SCROLL_AMOUNT, constants.defaultIosScrollAmount);
  assert.equal(DEFAULT_MOBILE_SCROLL_DURATION_MS, constants.defaultMobileScrollDurationMs);
  assert.equal(DEFAULT_IOS_SCROLL_DURATION_MS, constants.defaultIosScrollDurationMs);
});

test('scroll release policy agrees with the cross-platform parity table', () => {
  const { constants } = readScrollGestureFixture();
  assert.equal(
    resolveScrollExecutionOptions({}).releaseBehavior,
    constants.ordinaryScrollReleaseBehavior,
  );
  assert.equal(
    resolveScrollExecutionOptions({}, 'bottom').releaseBehavior,
    constants.edgeScrollReleaseBehavior,
  );
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
