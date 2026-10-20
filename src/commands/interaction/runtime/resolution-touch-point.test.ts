import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';
import { ref, selector } from './selector-read-utils.ts';

function postSnapshot() {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Link',
      label: 'feedItem-by-whiskers.test',
      rect: { x: 0, y: 180, width: 402, height: 520 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Link',
      label: "whiskers's avatar",
      rect: { x: 16, y: 196, width: 48, height: 48 },
      hittable: true,
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Mochi napping in a sunbeam #caturday',
      rect: { x: 72, y: 246, width: 300, height: 36 },
      hittable: true,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'A kitten asleep in sunlight.',
      rect: { x: 16, y: 292, width: 370, height: 330 },
      hittable: true,
    },
  ]);
}

test('runtime press refuses a zero-area selector target and dispatches no tap', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(
    makeSnapshotState([
      {
        index: 0,
        depth: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 402, height: 874 },
        hittable: true,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Clock',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        hittable: false,
      },
    ]),
    {
      tap: async (_context, point) => {
        calls.push(point);
        return { ok: true };
      },
    },
  );

  await assert.rejects(
    () => device.interactions.press(selector('label="Clock"'), { session: 'default' }),
    (error: unknown) => {
      assert.deepEqual(
        (error as { details?: Record<string, unknown> }).details,
        {
          reason: 'target_bounds_invalid',
          selector: 'label="Clock"',
          dispatched: 'no',
        },
        'the refusal names the typed reason, and discloses that no tap was dispatched',
      );
      return true;
    },
  );
  assert.deepEqual(calls, [], 'a target with no area must not be tapped at its origin');
});

test('runtime press refuses a sentinel-bounds selector target and dispatches no tap', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(
    makeSnapshotState([
      {
        index: 0,
        depth: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 402, height: 874 },
        hittable: true,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Clock',
        // `CGRectInfinite` spelled in the four doubles Apple spells it with: a failed read that
        // crossed a wire, whose centre is the origin.
        rect: {
          x: -Number.MAX_VALUE / 2,
          y: -Number.MAX_VALUE / 2,
          width: Number.MAX_VALUE,
          height: Number.MAX_VALUE,
        },
        hittable: false,
      },
    ]),
    {
      tap: async (_context, point) => {
        calls.push(point);
        return { ok: true };
      },
    },
  );

  await assert.rejects(
    () => device.interactions.press(selector('label="Clock"'), { session: 'default' }),
    (error: unknown) => {
      assert.deepEqual(
        (error as { details?: Record<string, unknown> }).details,
        {
          reason: 'target_bounds_invalid',
          selector: 'label="Clock"',
          dispatched: 'no',
        },
        'the refusal names the typed reason, and discloses that no tap was dispatched',
      );
      return true;
    },
  );
  assert.deepEqual(calls, [], 'a target with no usable centre must not be tapped at the origin');
});

test('runtime ref and selector paths dispatch the same parent-owned post point', async () => {
  const refCalls: Point[] = [];
  const selectorCalls: Point[] = [];
  const refDevice = createInteractionDevice(postSnapshot(), {
    tap: async (_context, point) => {
      refCalls.push(point);
      return { ok: true };
    },
  });
  const selectorDevice = createInteractionDevice(postSnapshot(), {
    tap: async (_context, point) => {
      selectorCalls.push(point);
      return { ok: true };
    },
  });

  await refDevice.interactions.click(ref('@e2'), { session: 'default' });
  await selectorDevice.interactions.click(selector('label="feedItem-by-whiskers.test"'), {
    session: 'default',
  });

  assert.equal(refCalls.length, 1);
  assert.deepEqual(selectorCalls, refCalls);
  assert.ok(refCalls[0]!.y < 292);
  assert.notDeepEqual(refCalls[0], { x: 201, y: 440 });
});
