import { test } from 'vitest';
import assert from 'node:assert/strict';
import { captureScrollEdgeState, readScrollEdgeState } from '../scroll-edge-state.ts';
import { scrollNode, windowRoot } from './scroll-edge-state-fixtures.ts';

/**
 * The pure door into the edge analyzer. `scroll <dir>` reads an edge decision off a tree it already
 * holds to say what its gesture did (#2714), which makes `containerRect` part of the answer: the
 * caller has to be able to tell "this content ends here" from "the tree named no container", and
 * `canScroll: false` alone cannot tell them apart.
 */

const CONTAINER = { x: 18, y: 178, width: 366, height: 662 };

test('readScrollEdgeState: a resolved container reports the frame the decision was taken on', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, { hiddenContentBelow: true, rect: CONTAINER }),
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Row',
      rect: { x: 24, y: 700, width: 300, height: 40 },
    },
  ];

  const state = await readScrollEdgeState(nodes, 'bottom');

  assert.equal(state.canScroll, true);
  assert.deepEqual(state.containerRect, CONTAINER);
});

test('readScrollEdgeState: a tree with no scroll container reports no frame to check a gesture against', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Tap me',
      rect: { x: 20, y: 40, width: 100, height: 40 },
    },
  ];

  const state = await readScrollEdgeState(nodes, 'bottom');

  assert.equal(state.canScroll, false);
  assert.equal(state.containerRect, undefined);
});

test('readScrollEdgeState: a zero-area scrollable resolves to no container and therefore no frame', async () => {
  const state = await readScrollEdgeState(
    [windowRoot(), scrollNode(1, { hiddenContentBelow: true, rect: { ...CONTAINER, height: 0 } })],
    'bottom',
  );

  assert.equal(state.containerRect, undefined);
});

/**
 * The reader must not become a second source of truth: the captured and pure doors disagreeing about
 * one tree would mean an edge loop and a movement claim reading different rules.
 */
test('readScrollEdgeState answers what captureScrollEdgeState answers for the same tree', async () => {
  const nodes = [windowRoot(), scrollNode(1, { hiddenContentBelow: true, rect: CONTAINER })];

  const captured = await captureScrollEdgeState({
    edge: 'bottom',
    captureNodes: async () => nodes,
  });
  const read = await readScrollEdgeState(nodes, 'bottom');

  assert.equal(read.canScroll, captured.canScroll);
  assert.deepEqual(read.containerRect, captured.containerRect);
  assert.equal(read.fingerprint, captured.fingerprint);
});
