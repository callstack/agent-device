import assert from 'node:assert/strict';
import fc from 'fast-check';
import { test } from 'vitest';
import { buildDragGesturePlan } from './gesture-plan.ts';

const DRAG_PROPERTY_RUNS = 100;

test('hold drag keeps one pointer down through source hold, movement, and destination hold', () => {
  const plan = buildDragGesturePlan(
    {
      from: { x: 20, y: 30 },
      to: { x: 120, y: 230 },
      sourceHoldMs: 800,
      moveMs: 700,
      destinationHoldMs: 250,
    },
    { x: 0, y: 0, width: 400, height: 800 },
    'ios',
  );

  assert.equal(plan.topology, 'single');
  assert.equal(plan.durationMs, 1_750);
  assert.deepEqual(plan.pointers[0]?.samples[0], { offsetMs: 0, point: { x: 20, y: 30 } });
  assert.deepEqual(plan.pointers[0]?.samples[1], { offsetMs: 800, point: { x: 20, y: 30 } });
  assert.deepEqual(plan.pointers[0]?.samples.at(-2), {
    offsetMs: 1_500,
    point: { x: 120, y: 230 },
  });
  assert.deepEqual(plan.pointers[0]?.samples.at(-1), {
    offsetMs: 1_750,
    point: { x: 120, y: 230 },
  });
});

test('hold drag rejects a combined duration above the backend ceiling', () => {
  assert.throws(
    () =>
      buildDragGesturePlan(
        {
          from: { x: 20, y: 30 },
          to: { x: 120, y: 230 },
          sourceHoldMs: 5_000,
          moveMs: 5_000,
          destinationHoldMs: 1,
        },
        { x: 0, y: 0, width: 400, height: 800 },
      ),
    { code: 'INVALID_ARGS', message: 'gesture drag total duration must be at most 10000' },
  );
});

test('every drag plan preserves ordered samples and exact hold/move endpoints', () => {
  const point = fc.record({
    x: fc.integer({ min: 2, max: 398 }),
    y: fc.integer({ min: 2, max: 798 }),
  });
  fc.assert(
    fc.property(
      point,
      point,
      fc.integer({ min: 1, max: 3_000 }),
      fc.integer({ min: 16, max: 3_000 }),
      fc.integer({ min: 0, max: 3_000 }),
      (from, to, sourceHoldMs, moveMs, destinationHoldMs) => {
        const plan = buildDragGesturePlan(
          { from, to, sourceHoldMs, moveMs, destinationHoldMs },
          { x: 0, y: 0, width: 400, height: 800 },
        );
        const samples = plan.pointers[0].samples;
        assert.equal(samples[0]?.offsetMs, 0);
        assert.deepEqual(samples[0]?.point, { x: from.x, y: from.y });
        assert.equal(samples[1]?.offsetMs, sourceHoldMs);
        assert.deepEqual(samples[1]?.point, { x: from.x, y: from.y });
        assert.equal(samples.at(-1)?.offsetMs, sourceHoldMs + moveMs + destinationHoldMs);
        assert.deepEqual(samples.at(-1)?.point, { x: to.x, y: to.y });
        for (let index = 1; index < samples.length; index += 1) {
          assert.ok(samples[index]!.offsetMs >= samples[index - 1]!.offsetMs);
        }
      },
    ),
    { numRuns: DRAG_PROPERTY_RUNS },
  );
});
