import { test } from 'vitest';
import assert from 'node:assert/strict';
import { capture, scrollNode, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// analyzeScrollEdgeState (private) exercised through captureScrollEdgeState:
// empty snapshot / no scrollable container
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: empty node list reports emptySnapshot and cannot scroll', async () => {
  const state = await capture([]);
  assert.deepEqual(state, { canScroll: false, emptySnapshot: true });
});

test('captureScrollEdgeState: no scrollable node anywhere yields a null container', async () => {
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
  const state = await capture(nodes);
  assert.equal(state.canScroll, false);
  assert.equal(state.emptySnapshot, false);
  assert.equal(state.scope, undefined);
});

test('captureScrollEdgeState: a scrollable node with a zero-width rect does not count as a container', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, { hiddenContentBelow: true, rect: { x: 0, y: 100, width: 0, height: 600 } }),
  ];
  const state = await capture(nodes);
  assert.equal(state.canScroll, false);
  assert.equal(state.scope, undefined);
});

test('captureScrollEdgeState: a scrollable node with a zero-height rect does not count as a container', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, { hiddenContentBelow: true, rect: { x: 0, y: 100, width: 400, height: 0 } }),
  ];
  const state = await capture(nodes);
  assert.equal(state.canScroll, false);
  assert.equal(state.scope, undefined);
});
