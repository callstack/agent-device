import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { readScrollPullContainer } from '../scroll-edge-state.ts';

/**
 * `pullRect` is the band of the chosen container a touch can reach, which only the analyzer can
 * answer: it follows the ancestry chain and knows which kinds of node clip their children. Which
 * container the pull is for is covered through the command path, where the gesture is planned.
 */

function app(width = 402, height = 874): SnapshotNode {
  return {
    ref: 'e1',
    index: 1,
    depth: 0,
    type: 'Application',
    kind: formatRole('Application'),
    rect: { x: 0, y: 0, width, height },
  };
}

function scroller(
  index: number,
  parentIndex: number,
  rect: SnapshotNode['rect'],
  overrides: Partial<SnapshotNode> = {},
): SnapshotNode {
  return {
    ref: `e${index}`,
    index,
    parentIndex,
    depth: 1,
    type: 'ScrollView',
    kind: formatRole('ScrollView'),
    rect,
    hiddenContentBelow: true,
    ...overrides,
  };
}

test('the pull band excludes the part of a nested scroller its clipping ancestor hides', async () => {
  // A nested list reports its content frame from y=605 while the ancestor showing it starts at
  // y=650, so those first 45 pixels are not on screen. A pull started there lands on whatever is
  // showing, the list never gets the first touch, and the refresh control never arms.
  const nested = { x: 0, y: 605, width: 820, height: 395 };
  const pull = await readScrollPullContainer([
    app(820, 1180),
    scroller(2, 1, { x: 0, y: 650, width: 820, height: 530 }),
    scroller(3, 2, nested, { identifier: 'refresh-list' }),
  ]);
  assert.deepEqual(pull?.containerRect, nested, 'the raw frame is the selected container');
  // 650 (the ancestor's top) to 1000 (the list's own bottom), shorter than either node's frame.
  assert.deepEqual(pull?.pullRect, { x: 0, y: 650, width: 820, height: 350 });
});

test('the pull band honours every clipping ancestor, not only the nearest one', async () => {
  // The list's nearest clipping ancestor (150..750) shows all 400px of it, but the ancestor above
  // ends at 550. Honouring only the nearest would plan 50px of travel the outer clip hides.
  const list = { x: 10, y: 200, width: 382, height: 400 };
  const pull = await readScrollPullContainer([
    app(),
    scroller(2, 1, { x: 0, y: 100, width: 402, height: 450 }),
    scroller(3, 2, { x: 0, y: 150, width: 402, height: 600 }),
    scroller(4, 3, list, { identifier: 'refresh-list' }),
  ]);
  assert.deepEqual(pull?.containerRect, list);
  assert.deepEqual(pull?.pullRect, { x: 10, y: 200, width: 382, height: 350 });
});

test('a list a clipping ancestor hides entirely yields an empty band, not its raw frame', async () => {
  // Nothing of the list is on screen (200..600 against a 650..750 ancestor). The band is empty at
  // that ancestor's edge rather than the raw 400px or the ancestor's own 100px, so the caller
  // refuses the pull instead of planning it onto pixels the list never receives.
  const pull = await readScrollPullContainer([
    app(820, 1180),
    scroller(2, 1, { x: 0, y: 650, width: 820, height: 100 }),
    scroller(3, 2, { x: 0, y: 200, width: 820, height: 400 }, { identifier: 'refresh-list' }),
  ]);
  assert.deepEqual(pull?.pullRect, { x: 0, y: 750, width: 820, height: 0 });
});

test('an ancestor reporting a degenerate frame does not empty the pull band', async () => {
  // A zero-height scroller frame is a capture artifact, not a clip: the root collection already
  // skips such rects, so the band keeps every pixel the real clipping ancestors leave on screen.
  const list = { x: 0, y: 200, width: 402, height: 400 };
  const pull = await readScrollPullContainer([
    app(),
    scroller(2, 1, { x: 0, y: 100, width: 402, height: 0 }, { hiddenContentBelow: false }),
    scroller(3, 2, list, { identifier: 'refresh-list' }),
  ]);
  assert.deepEqual(pull?.containerRect, list);
  assert.deepEqual(pull?.pullRect, list);
});

test('a plain group between a list and its clipping ancestor cannot shrink the pull band', async () => {
  // The closest negative: only nodes that clip by definition bound the pull, so a group reporting a
  // frame it does not clip must not shorten a pull whose pixels are all on screen.
  const list = { x: 0, y: 200, width: 402, height: 600 };
  const pull = await readScrollPullContainer([
    app(),
    scroller(2, 1, { x: 0, y: 100, width: 402, height: 700 }),
    {
      ref: 'e3',
      index: 3,
      parentIndex: 2,
      depth: 2,
      type: 'Group',
      kind: formatRole('Group'),
      rect: { x: 0, y: 300, width: 402, height: 100 },
    },
    scroller(4, 3, list, { identifier: 'refresh-list' }),
  ]);
  assert.deepEqual(pull?.containerRect, list);
  assert.deepEqual(pull?.pullRect, list);
});

test('the pull band is absent when the tree names no scroll container', async () => {
  const pull = await readScrollPullContainer([
    {
      ref: 'e1',
      index: 1,
      depth: 0,
      type: 'StaticText',
      kind: formatRole('StaticText'),
      label: 'No list here',
      rect: { x: 0, y: 100, width: 300, height: 40 },
    },
  ]);
  assert.equal(pull?.containerRect, undefined);
  assert.equal(pull?.pullRect, undefined);
});
