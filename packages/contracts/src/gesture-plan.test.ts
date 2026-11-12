import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildDragGesturePlan,
  densifyGesturePath,
  singlePointerPlanEndpoints,
} from './gesture-plan.ts';

const DRAG_PROPERTY_RUNS = 100;

test('drag keeps one pointer down through source hold, movement, and destination hold', () => {
  const plan = buildDragGesturePlan(
    {
      from: { x: 20, y: 30 },
      to: { x: 120, y: 230 },
      sourceHoldMs: 800,
      moveMs: 700,
      destinationHoldMs: 250,
    },
    { x: 0, y: 0, width: 400, height: 800 },
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
  assert.deepEqual(singlePointerPlanEndpoints(plan), {
    start: { x: 20, y: 30 },
    end: { x: 120, y: 230 },
  });
});

test('drag rejects a combined duration above the backend ceiling', () => {
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
  let state = 0x6d2b79f5;
  const next = (minimum: number, maximum: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return minimum + (state % (maximum - minimum + 1));
  };
  for (let run = 0; run < DRAG_PROPERTY_RUNS; run += 1) {
    const from = { x: next(2, 398), y: next(2, 798) };
    const to = { x: next(2, 398), y: next(2, 798) };
    const sourceHoldMs = next(1, 3_000);
    const moveMs = next(16, 3_000);
    const destinationHoldMs = next(0, 3_000);
    const plan = buildDragGesturePlan(
      { from, to, sourceHoldMs, moveMs, destinationHoldMs },
      { x: 0, y: 0, width: 400, height: 800 },
    );
    const samples = plan.pointers[0].samples;
    assert.equal(samples[0]?.offsetMs, 0);
    assert.deepEqual(samples[0]?.point, from);
    assert.equal(samples[1]?.offsetMs, sourceHoldMs);
    assert.deepEqual(samples[1]?.point, from);
    assert.equal(samples.at(-1)?.offsetMs, sourceHoldMs + moveMs + destinationHoldMs);
    assert.deepEqual(samples.at(-1)?.point, to);
    for (let index = 1; index < samples.length; index += 1) {
      assert.ok(samples[index]!.offsetMs >= samples[index - 1]!.offsetMs);
    }
  }
});

test('densifyGesturePath merges the profile grid into the canonical path and keeps its endpoints', () => {
  const canonical = [
    { offsetMs: 0, point: { x: 0, y: 0 } },
    { offsetMs: 100, point: { x: 100, y: 0 } },
    { offsetMs: 200, point: { x: 100, y: 100 } },
  ];
  const dense = densifyGesturePath(canonical, 200, 'default');

  // The 16 ms grid and the canonical offsets merge into one ascending timeline.
  const offsets = dense.map(({ offsetMs }) => offsetMs);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1), 200);
  assert.ok([...offsets].sort((left, right) => left - right).every((o, i) => o === offsets[i]));
  assert.deepEqual(dense[0]?.point, { x: 0, y: 0 });
  assert.deepEqual(dense.at(-1)?.point, { x: 100, y: 100 });
  // A merged grid offset inside the first segment interpolates on that segment's line.
  const at50 = dense.find(({ offsetMs }) => offsetMs === 50);
  assert.deepEqual(at50?.point, { x: 50, y: 0 });
  // Canonical offsets survive verbatim.
  const at100 = dense.find(({ offsetMs }) => offsetMs === 100);
  assert.deepEqual(at100?.point, { x: 100, y: 0 });
});

test('densifyGesturePath hands within-segment pacing to the progress hook and keeps its endpoint rule', () => {
  const canonical = [
    { offsetMs: 0, point: { x: 0, y: 0 } },
    { offsetMs: 100, point: { x: 100, y: 0 } },
  ];
  const seen: Array<[number, number]> = [];
  const dense = densifyGesturePath(canonical, 100, 'default', (progress, segmentDurationMs) => {
    seen.push([progress, segmentDurationMs]);
    return progress * progress;
  });

  const at50 = dense.find(({ offsetMs }) => offsetMs === 50);
  assert.deepEqual(at50?.point, { x: 25, y: 0 });
  assert.ok(
    seen.some(([progress, segmentDurationMs]) => progress === 0.5 && segmentDurationMs === 100),
  );
  // Endpoints never pass through the hook.
  assert.deepEqual(dense[0]?.point, { x: 0, y: 0 });
  assert.deepEqual(dense.at(-1)?.point, { x: 100, y: 0 });
});
