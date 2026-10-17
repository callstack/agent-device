import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Rect } from '@agent-device/kernel/snapshot';
import { buildScrollGesturePlan, type ScrollDirection } from './scroll-gesture.ts';

// The iPhone geometry #2714 was reported on: a 402x874 frame, the default 10% edge padding leaving
// x 40..362 and y 87..787 for a swipe.
const FRAME = { referenceWidth: 402, referenceHeight: 874 };
const PADDED_LEFT = 40;
const PADDED_TOP = 87;
const PADDED_BOTTOM = 787;
// Inset under a navigation bar and running to the bottom of the frame.
const INSET_CONTAINER: Rect = { x: 18, y: 178, width: 366, height: 662 };
// Inset at both ends: a footer sits below it, well above the padded band's bottom.
const FOOTERED_CONTAINER: Rect = { x: 18, y: 178, width: 366, height: 500 };
const FITTING_CONTAINER: Rect = { x: 18, y: 62, width: 366, height: 729 };

type Endpoints = { x1: number; y1: number; x2: number; y2: number };

/**
 * A container rect is half-open, as Android bounds and View hit-testing are: `y + height` is the
 * first row outside it. Strictly inside on both sides also keeps the drag off the edge row.
 */
function strictlyInside(plan: Endpoints, rect: Rect): boolean {
  const inside = (x: number, y: number) =>
    x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
  return inside(plan.x1, plan.y1) && inside(plan.x2, plan.y2);
}

test.each<[ScrollDirection, string, Rect]>([
  ['up', 'inset', INSET_CONTAINER],
  ['down', 'inset', INSET_CONTAINER],
  ['up', 'footered', FOOTERED_CONTAINER],
  ['down', 'footered', FOOTERED_CONTAINER],
])(
  'a %s swipe longer than an %s container shrinks inside it and reports both spans',
  (direction, _, container) => {
    const unclamped = buildScrollGesturePlan({ direction, amount: 0.75, ...FRAME });
    const plan = buildScrollGesturePlan({ direction, amount: 0.75, ...FRAME, container });

    assert.ok(strictlyInside(plan, container), JSON.stringify(plan));
    assert.ok(Math.max(plan.y1, plan.y2) <= PADDED_BOTTOM, JSON.stringify(plan));
    assert.equal(plan.pixels, Math.abs(plan.y2 - plan.y1));
    assert.ok(plan.pixels < unclamped.pixels);
    assert.equal(plan.requestedPixels, unclamped.pixels);
    assert.equal(Math.sign(plan.y2 - plan.y1), Math.sign(unclamped.y2 - unclamped.y1));
  },
);

test.each<ScrollDirection>(['left', 'right'])(
  'a %s swipe longer than a narrow container shrinks inside it along x',
  (direction) => {
    const column: Rect = { x: 100, y: 0, width: 200, height: 874 };
    const unclamped = buildScrollGesturePlan({ direction, ...FRAME });
    const plan = buildScrollGesturePlan({ direction, ...FRAME, container: column });

    assert.ok(strictlyInside(plan, column), JSON.stringify(plan));
    assert.deepEqual([plan.y1, plan.y2], [unclamped.y1, unclamped.y2]);
    assert.equal(plan.pixels, Math.abs(plan.x2 - plan.x1));
    assert.ok(plan.pixels < unclamped.pixels);
    assert.equal(plan.requestedPixels, unclamped.pixels);
    assert.equal(Math.sign(plan.x2 - plan.x1), Math.sign(unclamped.x2 - unclamped.x1));
  },
);

test('a horizontal swipe that fits an offset container moves into it without shortening', () => {
  const rightPane: Rect = { x: 180, y: 0, width: 222, height: 874 };
  const unclamped = buildScrollGesturePlan({ direction: 'left', pixels: 100, ...FRAME });
  const plan = buildScrollGesturePlan({
    direction: 'left',
    pixels: 100,
    ...FRAME,
    container: rightPane,
  });

  assert.ok(strictlyInside(plan, rightPane), JSON.stringify(plan));
  assert.equal(Math.abs(plan.x2 - plan.x1), Math.abs(unclamped.x2 - unclamped.x1));
  assert.equal(plan.pixels, unclamped.pixels);
  assert.equal('requestedPixels' in plan, false);
});

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

  assert.ok(strictlyInside(plan, lowerContainer), JSON.stringify(plan));
  assert.equal(Math.abs(plan.y1 - plan.y2), Math.abs(unclamped.y1 - unclamped.y2));
  assert.equal(plan.pixels, unclamped.pixels);
  assert.equal('requestedPixels' in plan, false);
});

test('an odd span that only loses its rounding pixel is not reported as shortened', () => {
  // On an 875-point axis the padded band is 88..787 (699 points), and a 699-point request centred
  // on 438 rounds its halves to a 700-point lane. Fitting it into the band drops that rounding
  // pixel, not any of the travel asked for.
  const frame = { referenceWidth: 402, referenceHeight: 875 };
  const wholeFrame: Rect = { x: 0, y: 0, width: 402, height: 875 };
  const plan = buildScrollGesturePlan({
    direction: 'up',
    pixels: 699,
    ...frame,
    container: wholeFrame,
  });

  assert.equal(plan.pixels, 699);
  assert.equal(Math.abs(plan.y2 - plan.y1), 699);
  assert.equal('requestedPixels' in plan, false);
});

test('a vertical swipe beside a narrow container moves across into it', () => {
  const rightColumn: Rect = { x: 250, y: 0, width: 152, height: 874 };
  const unclamped = buildScrollGesturePlan({ direction: 'up', ...FRAME });
  const plan = buildScrollGesturePlan({ direction: 'up', ...FRAME, container: rightColumn });

  assert.ok(strictlyInside(plan, rightColumn), JSON.stringify(plan));
  assert.ok(plan.x1 <= FRAME.referenceWidth - PADDED_LEFT, `swipe x ${plan.x1} is in the padding`);
  assert.equal(plan.x2, plan.x1);
  assert.deepEqual([plan.y1, plan.y2, plan.pixels], [unclamped.y1, unclamped.y2, unclamped.pixels]);
});

test('a container reaching into the side padding is swiped in the part the padding leaves', () => {
  const edgeColumn: Rect = { x: 0, y: 0, width: 60, height: 874 };
  const plan = buildScrollGesturePlan({ direction: 'up', ...FRAME, container: edgeColumn });

  assert.ok(strictlyInside(plan, edgeColumn), JSON.stringify(plan));
  assert.ok(plan.x1 >= PADDED_LEFT, `swipe x ${plan.x1} is inside the side padding`);
});

test.each<[ScrollDirection, string, Rect]>([
  [
    'up',
    'a navigation rail along the left edge',
    { x: 0, y: 0, width: PADDED_LEFT - 1, height: 874 },
  ],
  [
    'left',
    'a chip row just above the padded band',
    { x: 0, y: 60, width: 402, height: PADDED_TOP - 61 },
  ],
])(
  'a %s swipe aimed at %s runs inside it when the cross-axis padding leaves none of it',
  (direction, _, container) => {
    const unclamped = buildScrollGesturePlan({ direction, ...FRAME });
    const plan = buildScrollGesturePlan({ direction, ...FRAME, container });

    assert.ok(strictlyInside(plan, container), JSON.stringify(plan));
    assert.equal(plan.pixels, unclamped.pixels);
  },
);

test('a container lying wholly in the padding of the scrolled axis leaves the padded swipe as it was', () => {
  const statusBand: Rect = { x: 0, y: 0, width: 402, height: PADDED_TOP - 1 };
  const unclamped = buildScrollGesturePlan({ direction: 'up', ...FRAME });
  const plan = buildScrollGesturePlan({ direction: 'up', ...FRAME, container: statusBand });

  assert.deepEqual(plan, unclamped);
});
