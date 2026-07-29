import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { capture, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// analyzeScrollEdgeState (private) exercised through captureScrollEdgeState:
// empty snapshot / no scrollable container
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: empty node list reports emptySnapshot and cannot scroll', async () => {
  const state = await capture([]);
  assert.deepEqual(state, { canScroll: false, emptySnapshot: true });
});

test('captureScrollEdgeState: capture resolving to undefined is treated as an empty snapshot', async () => {
  const state = await capture(undefined as unknown as SnapshotNode[]);
  assert.equal(state.emptySnapshot, true);
  assert.equal(state.canScroll, false);
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
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 0, height: 600 },
    },
  ];
  const state = await capture(nodes);
  assert.equal(state.canScroll, false);
  assert.equal(state.scope, undefined);
});

test('captureScrollEdgeState: a scrollable node with a zero-height rect does not count as a container', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 0 },
    },
  ];
  const state = await capture(nodes);
  assert.equal(state.canScroll, false);
  assert.equal(state.scope, undefined);
});

// ---------------------------------------------------------------------------
// hasHiddenContentAtEdge: node-level flags, both edges
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: single container with hidden content below reports canScroll for bottom edge', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.canScroll, true);
});

test('captureScrollEdgeState: single container with hidden content above reports canScroll for top edge', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentAbove: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
  ];
  const state = await capture(nodes, 'top');
  assert.equal(state.canScroll, true);
});

test('captureScrollEdgeState: hidden content below does not satisfy a top-edge query', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
  ];
  const state = await capture(nodes, 'top');
  assert.equal(state.canScroll, false);
  // scope is still populated even though this edge cannot scroll — the container was found.
});

test('captureScrollEdgeState: container with neither hidden edge cannot scroll either direction', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
  ];
  assert.equal((await capture(nodes, 'bottom')).canScroll, false);
  assert.equal((await capture(nodes, 'top')).canScroll, false);
});

test('captureScrollEdgeState: hidden-content hint derived from an off-screen child (no node-level flag) also enables canScroll', async () => {
  // Container itself carries no hiddenContentBelow flag; an off-screen child below it
  // drives deriveMobileSnapshotHiddenContentHints to synthesize the hint.
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      label: 'Feed',
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
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
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      label: 'Feed',
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
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

// ---------------------------------------------------------------------------
// selectScrollContainer: target.nodeIndex resolution
// ---------------------------------------------------------------------------

test('selectScrollContainer: target.nodeIndex pointing directly at a scrollable node selects it over a broader hidden-edge distractor', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'target-container',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    // A distractor the broad (no-target) search would prefer, since it has a
    // hidden edge and a much larger area — proves the direct nodeIndex hit
    // short-circuits selection rather than coincidentally agreeing with it.
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'distractor',
      hiddenContentBelow: true,
      rect: { x: 150, y: 150, width: 300, height: 300 },
    },
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 1 });
  assert.equal(state.scope, 'target-container');
});

test('selectScrollContainer: target.nodeIndex pointing at a child resolves to its scrollable ancestor, not a broader distractor', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'ancestor-container',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Row',
      rect: { x: 20, y: 20, width: 60, height: 20 },
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'distractor',
      hiddenContentBelow: true,
      rect: { x: 150, y: 150, width: 300, height: 300 },
    },
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 2 });
  assert.equal(state.scope, 'ancestor-container');
});

test('selectScrollContainer: target.nodeIndex resolves through a two-level (grandchild) chain to its scrollable ancestor', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'ancestor-container',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Row',
      rect: { x: 20, y: 20, width: 60, height: 20 },
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 2,
      type: 'Text',
      label: 'Row label',
      rect: { x: 22, y: 22, width: 30, height: 10 },
    },
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 3 });
  assert.equal(state.scope, 'ancestor-container');
});

test('selectScrollContainer: target.nodeIndex with no scrollable ancestor falls back to the broad scrollable search', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Unrelated target',
      rect: { x: 20, y: 40, width: 100, height: 40 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'other-feed',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 1 });
  assert.equal(state.canScroll, true);
  assert.equal(state.scope, 'other-feed');
});

test('selectScrollContainer: an unknown target.nodeIndex is ignored rather than throwing', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'feed',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 999 });
  assert.equal(state.canScroll, true);
  assert.equal(state.scope, 'feed');
});

// ---------------------------------------------------------------------------
// selectScrollContainer: target.point resolution (specific selection)
// ---------------------------------------------------------------------------

test('selectScrollContainer: target.point inside nested scrollables with no hidden edge prefers the smallest container, ignoring a non-containing distractor', async () => {
  // 'outer' is declared before 'inner' (so a naive first-match without sorting
  // would wrongly pick 'outer'), and 'far-away' has a hidden edge but does NOT
  // contain the point (so a broken point filter that let it through would win
  // on hidden-edge preference instead of the correct smallest-containing pick).
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'outer',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'ScrollView',
      identifier: 'inner',
      rect: { x: 50, y: 50, width: 100, height: 100 },
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'far-away',
      hiddenContentBelow: true,
      rect: { x: 900, y: 900, width: 50, height: 50 },
    },
  ];
  const state = await capture(nodes, 'bottom', { point: { x: 75, y: 75 } });
  assert.equal(state.scope, 'inner');
});

test('selectScrollContainer: target.point inside nested scrollables prefers the one with a hidden edge over the smaller one', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'outer',
      hiddenContentBelow: true,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'ScrollView',
      identifier: 'inner',
      rect: { x: 50, y: 50, width: 100, height: 100 },
    },
  ];
  const state = await capture(nodes, 'bottom', { point: { x: 75, y: 75 } });
  assert.equal(state.canScroll, true);
  assert.equal(state.scope, 'outer');
});

test('selectScrollContainer: target.point outside every scrollable rect falls back to the broad search', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'outer',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'far-away',
      hiddenContentBelow: true,
      rect: { x: 200, y: 200, width: 100, height: 100 },
    },
  ];
  const state = await capture(nodes, 'bottom', { point: { x: 999, y: 999 } });
  assert.equal(state.canScroll, true);
  assert.equal(state.scope, 'far-away');
});

// ---------------------------------------------------------------------------
// selectScrollContainer: broad selection (no target), multiple scrollables
// ---------------------------------------------------------------------------

test('selectScrollContainer (broad): among containers with a hidden edge, the largest one wins', async () => {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'small-hidden',
      hiddenContentBelow: true,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'large-hidden',
      hiddenContentBelow: true,
      rect: { x: 0, y: 200, width: 300, height: 300 },
    },
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.scope, 'large-hidden');
});

test('selectScrollContainer (broad): with no hidden edge anywhere, the LARGEST visible-in-viewport container wins, not just the first visible one', async () => {
  // Declaration order deliberately disagrees with area order (visible-small is
  // declared first) so a sort-less "first visible" implementation would pick
  // the wrong one; offscreen-huge is bigger still but must be excluded by the
  // visibility filter entirely.
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'visible-small',
      rect: { x: 0, y: 0, width: 50, height: 50 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'visible-large',
      rect: { x: 0, y: 0, width: 200, height: 200 },
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'offscreen-huge',
      rect: { x: -5000, y: 0, width: 1000, height: 1000 },
    },
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.canScroll, false);
  assert.equal(state.scope, 'visible-large');
});

test('selectScrollContainer (broad): when nothing is visible, the LARGEST scrollable overall is chosen regardless of declaration order', async () => {
  // offscreen-small is declared first, offscreen-large second — a sort-less
  // "first" fallback would wrongly pick offscreen-small.
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'offscreen-small',
      rect: { x: -2000, y: 0, width: 100, height: 100 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'offscreen-large',
      rect: { x: -1000, y: 0, width: 300, height: 300 },
    },
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.scope, 'offscreen-large');
});

// ---------------------------------------------------------------------------
// containsPoint boundary (inclusive edges, and-of-four rather than or-of-any)
// ---------------------------------------------------------------------------

test('containsPoint: boundary is inclusive on every edge, and requires all four bounds together (not any pair)', async () => {
  const nodes: SnapshotNode[] = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'point-match',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    // Far away, but wins the broad (no-point-match) fallback via its hidden
    // edge — so if containsPoint wrongly matches, scope stays 'point-match';
    // if it correctly rejects, scope must become this distractor instead.
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'broad-winner',
      hiddenContentBelow: true,
      rect: { x: 1000, y: 1000, width: 300, height: 300 },
    },
  ];
  const scopeAt = async (point: { x: number; y: number }) =>
    (await capture(nodes, 'bottom', { point })).scope;

  // Inclusive corners: sitting exactly on the boundary still counts as inside.
  assert.equal(await scopeAt({ x: 0, y: 0 }), 'point-match');
  assert.equal(await scopeAt({ x: 100, y: 100 }), 'point-match');

  // Failing exactly one of the four bounds must exclude the container outright,
  // not merely satisfy some other bound via a broken OR.
  assert.equal(await scopeAt({ x: -1, y: 50 }), 'broad-winner');
  assert.equal(await scopeAt({ x: 101, y: 50 }), 'broad-winner');
  assert.equal(await scopeAt({ x: 50, y: -1 }), 'broad-winner');
  assert.equal(await scopeAt({ x: 50, y: 101 }), 'broad-winner');
});
