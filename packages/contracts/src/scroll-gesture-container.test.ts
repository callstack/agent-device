import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Rect } from '@agent-device/kernel/snapshot';
import { buildScrollGesturePlan, type ScrollDirection } from './scroll-gesture.ts';

// The iPhone geometry #2714 was reported on: a 402x874 frame, the default 10% edge padding leaving
// y 87..787 for a swipe.
const FRAME = { referenceWidth: 402, referenceHeight: 874 };
const PADDED_TOP = 87;
const PADDED_BOTTOM = 787;
const INSET_CONTAINER: Rect = { x: 18, y: 178, width: 366, height: 662 };
const FITTING_CONTAINER: Rect = { x: 18, y: 62, width: 366, height: 729 };

function endpointsInside(
  plan: { x1: number; y1: number; x2: number; y2: number },
  rect: Rect,
): boolean {
  const inside = (x: number, y: number) =>
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  return inside(plan.x1, plan.y1) && inside(plan.x2, plan.y2);
}

test.each<ScrollDirection>(['up', 'down'])(
  'a %s swipe longer than an inset container shrinks to the container and reports both spans',
  (direction) => {
    const unclamped = buildScrollGesturePlan({ direction, amount: 0.75, ...FRAME });
    const plan = buildScrollGesturePlan({
      direction,
      amount: 0.75,
      ...FRAME,
      container: INSET_CONTAINER,
    });

    assert.ok(endpointsInside(plan, INSET_CONTAINER), JSON.stringify(plan));
    assert.deepEqual(
      [Math.min(plan.y1, plan.y2), Math.max(plan.y1, plan.y2)],
      [INSET_CONTAINER.y, PADDED_BOTTOM],
    );
    assert.equal(plan.pixels, PADDED_BOTTOM - INSET_CONTAINER.y);
    assert.equal(plan.requestedPixels, unclamped.pixels);
    assert.equal(Math.sign(plan.y2 - plan.y1), Math.sign(unclamped.y2 - unclamped.y1));
  },
);

test.each<ScrollDirection>(['up', 'down', 'left', 'right'])(
  'a %s swipe already inside its container keeps today’s endpoints and distance',
  (direction) => {
    const unclamped = buildScrollGesturePlan({ direction, amount: 0.75, ...FRAME });
    const plan = buildScrollGesturePlan({
      direction,
      amount: 0.75,
      ...FRAME,
      container: FITTING_CONTAINER,
    });

    assert.deepEqual(plan, unclamped);
    assert.equal('requestedPixels' in plan, false);
  },
);

test('a swipe that fits an offset container moves into it without shortening', () => {
  const lowerContainer: Rect = { x: 0, y: 300, width: 402, height: 574 };
  const unclamped = buildScrollGesturePlan({ direction: 'down', amount: 0.5, ...FRAME });
  const plan = buildScrollGesturePlan({
    direction: 'down',
    amount: 0.5,
    ...FRAME,
    container: lowerContainer,
  });

  assert.ok(endpointsInside(plan, lowerContainer), JSON.stringify(plan));
  assert.equal(Math.min(plan.y1, plan.y2), lowerContainer.y);
  assert.equal(Math.abs(plan.y1 - plan.y2), Math.abs(unclamped.y1 - unclamped.y2));
  assert.equal(plan.pixels, unclamped.pixels);
  assert.equal('requestedPixels' in plan, false);
});

test('a vertical swipe beside a narrow container runs down its centre line', () => {
  const rightColumn: Rect = { x: 250, y: 0, width: 152, height: 874 };
  const unclamped = buildScrollGesturePlan({ direction: 'up', ...FRAME });
  const plan = buildScrollGesturePlan({ direction: 'up', ...FRAME, container: rightColumn });

  assert.equal(plan.x1, rightColumn.x + rightColumn.width / 2);
  assert.equal(plan.x2, plan.x1);
  assert.deepEqual([plan.y1, plan.y2, plan.pixels], [unclamped.y1, unclamped.y2, unclamped.pixels]);
});

test('a container lying wholly in the edge padding leaves the padded swipe as it was', () => {
  const statusBand: Rect = { x: 0, y: 0, width: 402, height: PADDED_TOP - 1 };
  const unclamped = buildScrollGesturePlan({ direction: 'up', ...FRAME });
  const plan = buildScrollGesturePlan({ direction: 'up', ...FRAME, container: statusBand });

  assert.deepEqual(plan, unclamped);
});
