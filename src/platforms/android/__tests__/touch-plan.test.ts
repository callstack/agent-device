import assert from 'node:assert/strict';
import { expectTypeOf, test } from 'vitest';
import {
  buildDragGesturePlan,
  buildGesturePlan,
  type SinglePointerGesturePlan,
} from '@agent-device/contracts/interaction';
import { lowerAndroidTouchPlan, type AndroidLoweredTouchPlan } from '../touch-plan.ts';
import { longPressPlan } from './touch-helper.fixtures.ts';

const viewport = { x: 0, y: 0, width: 400, height: 800 };

test('lowers a 500 ms endpoint plan with the Android rounded cadence', () => {
  const plan = buildGesturePlan(
    {
      intent: 'pan',
      origin: { x: 100, y: 200 },
      delta: { x: 100, y: 200 },
      durationMs: 500,
    },
    viewport,
  );
  const lowered = lowerAndroidTouchPlan(plan);

  assert.equal(lowered.topology, 'single');
  assert.equal(lowered.pointers[0].samples.length, 32);
  assert.deepEqual(
    lowered.pointers[0].samples.map(({ offsetMs }) => offsetMs),
    [
      0, 16, 32, 48, 65, 81, 97, 113, 129, 145, 161, 177, 194, 210, 226, 242, 258, 274, 290, 306,
      323, 339, 355, 371, 387, 403, 419, 435, 452, 468, 484, 500,
    ],
  );
});

test('preserves the pre-endpoint Android sample schedule and interpolation', () => {
  const plan = buildGesturePlan(
    { intent: 'fling', from: { x: 300, y: 400 }, to: { x: 100, y: 400 } },
    viewport,
  );
  const lowered = lowerAndroidTouchPlan(plan);

  assert.deepEqual(lowered.pointers[0].samples, [
    { offsetMs: 0, point: { x: 300, y: 400 } },
    { offsetMs: 17, point: { x: 266, y: 400 } },
    { offsetMs: 33, point: { x: 234, y: 400 } },
    { offsetMs: 50, point: { x: 200, y: 400 } },
    { offsetMs: 67, point: { x: 166, y: 400 } },
    { offsetMs: 83, point: { x: 134, y: 400 } },
    { offsetMs: 100, point: { x: 100, y: 400 } },
  ]);
});

test('lowers drag trajectories piecewise without dropping either hold or movement', () => {
  const source = { x: 20, y: 30 };
  const destination = { x: 120, y: 230 };
  const plan = buildDragGesturePlan(
    {
      from: source,
      to: destination,
      sourceHoldMs: 75,
      moveMs: 90,
      destinationHoldMs: 35,
    },
    viewport,
  );

  const lowered = lowerAndroidTouchPlan(plan);
  const samples = lowered.pointers[0].samples;

  assert.deepEqual(
    samples.filter(({ offsetMs }) => offsetMs <= 75).map(({ point }) => point),
    Array.from({ length: samples.filter(({ offsetMs }) => offsetMs <= 75).length }, () => source),
  );
  assert.deepEqual(samples.find(({ offsetMs }) => offsetMs === 75)?.point, source);
  assert.ok(
    samples.some(
      ({ offsetMs, point }) =>
        offsetMs > 75 &&
        offsetMs < 165 &&
        point.x > source.x &&
        point.x < destination.x &&
        point.y > source.y &&
        point.y < destination.y,
    ),
  );
  assert.deepEqual(samples.find(({ offsetMs }) => offsetMs === 165)?.point, destination);
  assert.deepEqual(
    samples.filter(({ offsetMs }) => offsetMs >= 165).map(({ point }) => point),
    Array.from(
      { length: samples.filter(({ offsetMs }) => offsetMs >= 165).length },
      () => destination,
    ),
  );
});

test('does not lower long-press or two-pointer plans', () => {
  const longPress = longPressPlan();
  assert.equal(lowerAndroidTouchPlan(longPress), longPress);

  const twoPointer = buildGesturePlan(
    {
      intent: 'pan',
      pointerCount: 2,
      origin: { x: 200, y: 300 },
      delta: { x: 20, y: 10 },
      durationMs: 32,
    },
    viewport,
  );
  assert.equal(lowerAndroidTouchPlan(twoPointer), twoPointer);
});

test('lowered endpoint plans are valid Android transport plans', () => {
  const plan = buildGesturePlan(
    {
      intent: 'pan',
      origin: { x: 100, y: 200 },
      delta: { x: 100, y: 200 },
      durationMs: 64,
    },
    viewport,
  );
  const lowered: AndroidLoweredTouchPlan = lowerAndroidTouchPlan(plan);
  assert.equal(lowered.pointers[0].samples.length, 5);
});

// The transport types are the enforcement, so widening them back to a plain sample array must
// fail a gate rather than quietly re-admit a two-sample plan at the injection seams.
test('a canonical endpoint plan cannot reach the transport unlowered', () => {
  expectTypeOf<SinglePointerGesturePlan>().not.toExtend<AndroidLoweredTouchPlan>();
  expectTypeOf<ReturnType<typeof lowerAndroidTouchPlan>>().toExtend<AndroidLoweredTouchPlan>();
});
