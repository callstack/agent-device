import { test } from 'vitest';
import assert from 'node:assert/strict';
import { capture, scrollNode, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// hasHiddenContentAtEdge: node-level flags, both edges
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: single container with hidden content below reports canScroll for bottom edge', async () => {
  const nodes = [windowRoot(), scrollNode(1, { hiddenContentBelow: true })];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.canScroll, true);
});

test('captureScrollEdgeState: single container with hidden content above reports canScroll for top edge', async () => {
  const nodes = [windowRoot(), scrollNode(1, { hiddenContentAbove: true })];
  const state = await capture(nodes, 'top');
  assert.equal(state.canScroll, true);
});

test('captureScrollEdgeState: hidden content below does not satisfy a top-edge query', async () => {
  const nodes = [windowRoot(), scrollNode(1, { hiddenContentBelow: true })];
  const state = await capture(nodes, 'top');
  assert.equal(state.canScroll, false);
  // scope is still populated even though this edge cannot scroll — the container was found.
});

test('captureScrollEdgeState: container with neither hidden edge cannot scroll either direction', async () => {
  const nodes = [windowRoot(), scrollNode(1)];
  assert.equal((await capture(nodes, 'bottom')).canScroll, false);
  assert.equal((await capture(nodes, 'top')).canScroll, false);
});

test('captureScrollEdgeState: hidden-content hint derived from an off-screen child (no node-level flag) also enables canScroll', async () => {
  // Container itself carries no hiddenContentBelow flag; an off-screen child below it
  // drives deriveMobileSnapshotHiddenContentHints to synthesize the hint.
  const nodes = [
    windowRoot(),
    scrollNode(1, { label: 'Feed' }),
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Below the fold',
      rect: { x: 20, y: 750, width: 300, height: 40 },
    },
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.canScroll, true);
});

test('captureScrollEdgeState: hidden-content hint derived from an off-screen child (top edge) also enables canScroll', async () => {
  // Mirror of the bottom-edge hint test above: the container itself carries no
  // hiddenContentAbove flag; an off-screen child ABOVE it drives the hint instead.
  const nodes = [
    windowRoot(),
    scrollNode(1, { label: 'Feed' }),
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Above the fold',
      rect: { x: 20, y: 20, width: 300, height: 40 },
    },
  ];
  const state = await capture(nodes, 'top');
  assert.equal(state.canScroll, true);
});
