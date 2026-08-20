import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { capture, scrollNode, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// selectScrollContainer: target.nodeIndex resolution
// ---------------------------------------------------------------------------

test('selectScrollContainer: target.nodeIndex pointing directly at a scrollable node selects it over a broader hidden-edge distractor', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, {
      identifier: 'target-container',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    }),
    // A distractor the broad (no-target) search would prefer, since it has a
    // hidden edge and a much larger area — proves the direct nodeIndex hit
    // short-circuits selection rather than coincidentally agreeing with it.
    scrollNode(2, {
      identifier: 'distractor',
      hiddenContentBelow: true,
      rect: { x: 150, y: 150, width: 300, height: 300 },
    }),
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 1 });
  assert.equal(state.scope, 'target-container');
});

test('selectScrollContainer: target.nodeIndex pointing at a child resolves to its scrollable ancestor, not a broader distractor', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, {
      identifier: 'ancestor-container',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    }),
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Row',
      rect: { x: 20, y: 20, width: 60, height: 20 },
    },
    scrollNode(3, {
      identifier: 'distractor',
      hiddenContentBelow: true,
      rect: { x: 150, y: 150, width: 300, height: 300 },
    }),
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 2 });
  assert.equal(state.scope, 'ancestor-container');
});

test('selectScrollContainer: target.nodeIndex resolves through a two-level (grandchild) chain to its scrollable ancestor', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, {
      identifier: 'ancestor-container',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    }),
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
    scrollNode(2, { identifier: 'other-feed', hiddenContentBelow: true }),
  ];
  const state = await capture(nodes, 'bottom', { nodeIndex: 1 });
  assert.equal(state.canScroll, true);
  assert.equal(state.scope, 'other-feed');
});

test('selectScrollContainer: an unknown target.nodeIndex is ignored rather than throwing', async () => {
  const nodes = [windowRoot(), scrollNode(1, { identifier: 'feed', hiddenContentBelow: true })];
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
    scrollNode(1, { identifier: 'outer', rect: { x: 0, y: 0, width: 400, height: 800 } }),
    scrollNode(2, {
      parentIndex: 1,
      identifier: 'inner',
      rect: { x: 50, y: 50, width: 100, height: 100 },
    }),
    scrollNode(3, {
      identifier: 'far-away',
      hiddenContentBelow: true,
      rect: { x: 900, y: 900, width: 50, height: 50 },
    }),
  ];
  const state = await capture(nodes, 'bottom', { point: { x: 75, y: 75 } });
  assert.equal(state.scope, 'inner');
});

test('selectScrollContainer: target.point inside nested scrollables prefers the one with a hidden edge over the smaller one', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, {
      identifier: 'outer',
      hiddenContentBelow: true,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    }),
    scrollNode(2, {
      parentIndex: 1,
      identifier: 'inner',
      rect: { x: 50, y: 50, width: 100, height: 100 },
    }),
  ];
  const state = await capture(nodes, 'bottom', { point: { x: 75, y: 75 } });
  assert.equal(state.canScroll, true);
  assert.equal(state.scope, 'outer');
});

test('selectScrollContainer: target.point outside every scrollable rect falls back to the broad search', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, { identifier: 'outer', rect: { x: 0, y: 0, width: 100, height: 100 } }),
    scrollNode(2, {
      identifier: 'far-away',
      hiddenContentBelow: true,
      rect: { x: 200, y: 200, width: 100, height: 100 },
    }),
  ];
  const state = await capture(nodes, 'bottom', { point: { x: 999, y: 999 } });
  assert.equal(state.canScroll, true);
  assert.equal(state.scope, 'far-away');
});

test('selectScrollContainer: a point miss with no hidden edge keeps broad selection instead of adopting implicit viewport-center targeting', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, {
      identifier: 'centered-small',
      rect: { x: 150, y: 350, width: 100, height: 100 },
    }),
    scrollNode(2, {
      identifier: 'broad-large',
      rect: { x: 0, y: 0, width: 350, height: 300 },
    }),
  ];

  const state = await capture(nodes, 'bottom', { point: { x: 999, y: 999 } });

  assert.equal(state.scope, 'broad-large');
});

// ---------------------------------------------------------------------------
// containsPoint boundary (inclusive edges, and-of-four rather than or-of-any)
// ---------------------------------------------------------------------------

test('containsPoint: boundary is inclusive on every edge, and requires all four bounds together (not any pair)', async () => {
  const nodes: SnapshotNode[] = [
    windowRoot(),
    scrollNode(1, { identifier: 'point-match', rect: { x: 0, y: 0, width: 100, height: 100 } }),
    // Far away, but wins the broad (no-point-match) fallback via its hidden
    // edge — so if containsPoint wrongly matches, scope stays 'point-match';
    // if it correctly rejects, scope must become this distractor instead.
    scrollNode(2, {
      identifier: 'broad-winner',
      hiddenContentBelow: true,
      rect: { x: 1000, y: 1000, width: 300, height: 300 },
    }),
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
