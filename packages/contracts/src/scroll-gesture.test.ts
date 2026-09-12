import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  assertScrollGestureInput,
  buildInPageSwipeGesturePlan,
  buildScrollGesturePlan,
  clampGestureCoordinate,
  SCROLL_KEYBOARD_ACCESSORY_ALLOWANCE,
  SCROLL_KEYBOARD_MIN_VISIBLE_FRACTION,
  SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON,
  clipScrollViewportAboveKeyboard,
  scrollKeyboardOccludesSurfaceError,
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

// Golden parity table: the SAME JSON is asserted against the Swift twin
// (ScrollViewportPolicy in apple/runner/AgentDeviceRunner/
// AgentDeviceRunnerUITests/RunnerScrollViewportPolicy.swift, gated XCTest in the same file), so
// a clip that drifts between the iOS runner and the Android/TS owner turns CI red on whichever
// side changed, without a simulator.

type ExpectedClip =
  | { kind: 'unobstructed' }
  | { kind: 'avoided'; viewport: Rect; keyboardMinY: number }
  | { kind: 'occluded'; keyboardMinY: number; visibleHeight: number };

type FixtureCase = {
  name: string;
  viewport: Rect;
  keyboard: Rect;
  expected: ExpectedClip;
};

type Fixture = {
  constants: {
    minVisibleFraction: number;
    accessoryAllowance: number;
    occlusionReason: string;
  };
  cases: FixtureCase[];
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'scroll-keyboard-policy.json',
);

function loadTable(): Fixture {
  return JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as Fixture;
}

test('the scroll keyboard clip agrees with every golden parity table case', () => {
  const table = loadTable();
  assert.ok(table.cases.length > 0, 'parity table must not be empty');
  const names = new Set(table.cases.map((fixture) => fixture.name));
  assert.equal(names.size, table.cases.length, 'parity table case names must be unique');
  for (const fixture of table.cases) {
    assert.deepEqual(
      clipScrollViewportAboveKeyboard(fixture.viewport, fixture.keyboard),
      fixture.expected,
      fixture.name,
    );
  }
});

test('the keyboard clip thresholds and refusal keys belong to the table, not this file', () => {
  const { constants } = loadTable();
  assert.equal(constants.minVisibleFraction, SCROLL_KEYBOARD_MIN_VISIBLE_FRACTION);
  assert.equal(constants.accessoryAllowance, SCROLL_KEYBOARD_ACCESSORY_ALLOWANCE);
  assert.equal(constants.occlusionReason, SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON);
});

test('a clipped viewport keeps even a saturated swipe inside the visible band', () => {
  // The whole point of clipping before planning: `buildScrollGesturePlan` is untouched and gets the
  // clipped axis, so its own edge padding is what holds the gesture above the keyboard.
  const viewport: Rect = { x: 0, y: 0, width: 402, height: 874 };
  const clip = clipScrollViewportAboveKeyboard(viewport, {
    x: 0,
    y: 564,
    width: 402,
    height: 310,
  });
  assert.equal(clip.kind, 'avoided');
  if (clip.kind !== 'avoided') return;
  const plan = buildScrollGesturePlan({
    direction: 'down',
    amount: 10,
    referenceWidth: clip.viewport.width,
    referenceHeight: clip.viewport.height,
  });
  assert.ok(Math.max(plan.y1, plan.y2) <= clip.viewport.height);
  assert.ok(plan.pixels < clip.viewport.height, 'honored travel must name the clipped axis');
});

test('an unusable keyboard frame fails open instead of refusing every scroll', () => {
  const viewport: Rect = { x: 0, y: 0, width: 402, height: 874 };
  for (const keyboard of [
    { x: 0, y: Number.NaN, width: 402, height: 310 },
    { x: 0, y: 564, width: Number.POSITIVE_INFINITY, height: 310 },
    { x: 0, y: 564, width: 402, height: -310 },
    { x: 0, y: 564, width: 402, height: 0 },
  ] satisfies Rect[]) {
    assert.equal(clipScrollViewportAboveKeyboard(viewport, keyboard).kind, 'unobstructed');
  }
});

test('the occlusion refusal is keyed on its reason, not on its message', () => {
  const error = scrollKeyboardOccludesSurfaceError('down', {
    kind: 'occluded',
    keyboardMinY: 564,
    visibleHeight: 40,
    viewportHeight: 874,
  });
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.reason, SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON);
  assert.equal(error.details?.keyboardMinY, 564);
  assert.equal(error.details?.visibleHeight, 40);
  assert.equal(error.details?.viewportHeight, 874);
  assert.match(String(error.details?.hint), /keyboard dismiss/);
});

test('an unmeasured refusal still names the same reason, so error text never gates recovery', () => {
  // The iOS runner refuses in its own coordinate space and reports only its typed runner code, so
  // the Apple owner rebuilds this error without numbers. Matching on `reason` has to yield the
  // same key with or without a measurement, or the message becomes the discriminator.
  const unmeasured = scrollKeyboardOccludesSurfaceError('down');
  const measured = scrollKeyboardOccludesSurfaceError('down', {
    kind: 'occluded',
    keyboardMinY: 564,
    visibleHeight: 40,
    viewportHeight: 874,
  });
  assert.equal(unmeasured.details?.reason, measured.details?.reason);
  assert.equal(unmeasured.details?.keyboardMinY, undefined);
  assert.equal(unmeasured.details?.visibleHeight, undefined);
  assert.ok(!String(unmeasured.message).includes('px of'), 'no fabricated measurement may appear');
});
