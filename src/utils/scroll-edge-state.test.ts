import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdgeState,
  type ScrollEdgeTarget,
} from './scroll-edge-state.ts';
import { AppError } from '../kernel/errors.ts';
import type { RawSnapshotNode, SnapshotNode } from '../kernel/snapshot.ts';

// ---------------------------------------------------------------------------
// formatScrollEdgeMessage — pure formatter, 5 mutually exclusive branches
// ---------------------------------------------------------------------------

test('formatScrollEdgeMessage: edge reached with zero passes reports already-at-edge (bottom)', () => {
  assert.equal(
    formatScrollEdgeMessage('down', 'bottom', 0, undefined, undefined),
    'Already at bottom; no hidden content below detected',
  );
});

test('formatScrollEdgeMessage: edge reached with zero passes reports already-at-edge (top)', () => {
  assert.equal(
    formatScrollEdgeMessage('up', 'top', 0, undefined, undefined),
    'Already at top; no hidden content above detected',
  );
});

test('formatScrollEdgeMessage: edge reached after N passes', () => {
  assert.equal(
    formatScrollEdgeMessage('down', 'bottom', 4, undefined, undefined),
    'Scrolled to bottom with 4 down passes',
  );
});

test('formatScrollEdgeMessage: no edge, pixel amount given', () => {
  assert.equal(
    formatScrollEdgeMessage('down', undefined, 0, undefined, 250),
    'Scrolled down by 250px',
  );
});

test('formatScrollEdgeMessage: no edge, no pixels, symbolic amount given', () => {
  assert.equal(formatScrollEdgeMessage('up', undefined, 0, 3, undefined), 'Scrolled up by 3');
});

test('formatScrollEdgeMessage: no edge, no pixels, no amount falls back to bare direction', () => {
  assert.equal(
    formatScrollEdgeMessage('left', undefined, 0, undefined, undefined),
    'Scrolled left',
  );
});

test('formatScrollEdgeMessage: pixels takes priority over amount when both are set', () => {
  assert.equal(formatScrollEdgeMessage('down', undefined, 0, 3, 250), 'Scrolled down by 250px');
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function windowRoot(): SnapshotNode {
  return {
    ref: 'e1',
    index: 0,
    depth: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };
}

async function capture(
  nodes: readonly (RawSnapshotNode | SnapshotNode)[],
  edge: 'top' | 'bottom' = 'bottom',
  target?: ScrollEdgeTarget,
): Promise<ScrollEdgeState> {
  return captureScrollEdgeState({
    edge,
    target,
    captureNodes: async () => nodes,
  });
}

// ---------------------------------------------------------------------------
// analyzeScrollEdgeState (private) exercised through captureScrollEdgeState:
// empty snapshot / no scrollable container
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: empty node list reports emptySnapshot and cannot scroll', async () => {
  const state = await capture([]);
  assert.deepEqual(state, { canScroll: false, emptySnapshot: true, signature: '' });
});

test('captureScrollEdgeState: capture resolving to undefined is treated as an empty snapshot', async () => {
  const state = await captureScrollEdgeState({
    edge: 'bottom',
    captureNodes: async () => undefined as unknown as SnapshotNode[],
  });
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
  assert.notEqual(state.signature, '');
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
// buildScrollContainerScope / isUsefulScope
// ---------------------------------------------------------------------------

async function scopeFor(node: Partial<SnapshotNode>): Promise<string | undefined> {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
      ...node,
    },
  ];
  return (await capture(nodes, 'bottom')).scope;
}

test('buildScrollContainerScope: identifier is preferred over label', async () => {
  assert.equal(await scopeFor({ identifier: 'feed', label: 'Feed list' }), 'feed');
});

test('buildScrollContainerScope: label is used when identifier is empty', async () => {
  assert.equal(await scopeFor({ identifier: '', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier is a boolean-like string', async () => {
  assert.equal(await scopeFor({ identifier: 'TRUE', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier is pure digits', async () => {
  assert.equal(await scopeFor({ identifier: '12345', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier is a percentage', async () => {
  assert.equal(await scopeFor({ identifier: '45%', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier exceeds 80 characters', async () => {
  assert.equal(await scopeFor({ identifier: 'x'.repeat(81), label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: value is never used as a fallback scope, even when identifier and label both fail', async () => {
  assert.equal(await scopeFor({ identifier: '123', label: '50%', value: 'Messages' }), undefined);
});

test('buildScrollContainerScope: undefined when identifier and label are both unusable', async () => {
  assert.equal(await scopeFor({ identifier: 'false', label: '100%', value: '999' }), undefined);
});

test('buildScrollContainerScope: undefined when none of the fields are set', async () => {
  assert.equal(await scopeFor({}), undefined);
});

test('buildScrollContainerScope: a normal label with parentheses and digits is a useful scope', async () => {
  assert.equal(await scopeFor({ label: 'Recents (12)' }), 'Recents (12)');
});

test('buildScrollContainerScope: a label that is exactly 80 characters is still useful', async () => {
  const eighty = 'a'.repeat(80);
  assert.equal(await scopeFor({ identifier: '', label: eighty }), eighty);
});

test('buildScrollContainerScope: whitespace-only identifier is trimmed to empty and falls through to label', async () => {
  // Untrimmed, two spaces would have length > 0 and match none of the reject
  // patterns, so it would incorrectly pass isUsefulScope as-is.
  assert.equal(await scopeFor({ identifier: '  ', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: surrounding whitespace on an otherwise-useful identifier is trimmed off', async () => {
  assert.equal(await scopeFor({ identifier: '  feed  ' }), 'feed');
});

test('isUsefulScope: the true/false and digit/percentage checks require a full-string match, not a prefix or suffix match', async () => {
  // Each value below deliberately starts or ends with a reject pattern's
  // literal text while not equaling it exactly, so it must be ACCEPTED as a
  // useful scope. A reject regex missing its ^ or $ anchor would wrongly
  // match these as prefixes/suffixes and reject them instead.
  assert.equal(await scopeFor({ identifier: 'trueish' }), 'trueish');
  assert.equal(await scopeFor({ identifier: 'istrue' }), 'istrue');
  assert.equal(await scopeFor({ identifier: '123abc' }), '123abc');
  assert.equal(await scopeFor({ identifier: 'abc123' }), 'abc123');
  assert.equal(await scopeFor({ identifier: '50%off' }), '50%off');
  assert.equal(await scopeFor({ identifier: 'off50%' }), 'off50%');
});

// ---------------------------------------------------------------------------
// captureScrollEdgeState: retry-without-scope on an empty scoped capture
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: an empty scoped capture retries exactly once, without the scope', async () => {
  const calls: (string | undefined)[] = [];
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

  const state = await captureScrollEdgeState({
    edge: 'bottom',
    scope: 'stale-scope',
    captureNodes: async (scope) => {
      calls.push(scope);
      return scope ? [] : nodes;
    },
  });

  assert.deepEqual(calls, ['stale-scope', undefined]);
  assert.equal(state.canScroll, true);
  assert.equal(state.emptySnapshot, false);
});

test('captureScrollEdgeState: an empty capture with no scope does not retry', async () => {
  let callCount = 0;
  const state = await captureScrollEdgeState({
    edge: 'bottom',
    captureNodes: async () => {
      callCount += 1;
      return [];
    },
  });
  assert.equal(callCount, 1);
  assert.equal(state.emptySnapshot, true);
});

// ---------------------------------------------------------------------------
// captureScrollEdgeState: error wrapping
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: a captureNodes failure is wrapped in a COMMAND_FAILED AppError, scoped variant', async () => {
  const original = new Error('runner timed out');
  await assert.rejects(
    captureScrollEdgeState({
      edge: 'bottom',
      scope: 'feed',
      captureNodes: async () => {
        throw original;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Failed to verify scroll bottom state for scoped container');
      assert.deepEqual(error.details, {
        scope: 'feed',
        hint: 'scroll bottom could not verify the scoped scroll container. Run snapshot -i for the current screen and retry with a visible scroll target.',
      });
      assert.equal(error.cause, original);
      return true;
    },
  );
});

test('captureScrollEdgeState: a captureNodes failure is wrapped in a COMMAND_FAILED AppError, unscoped variant (bottom edge)', async () => {
  const original = new Error('runner timed out');
  await assert.rejects(
    captureScrollEdgeState({
      edge: 'bottom',
      captureNodes: async () => {
        throw original;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Failed to verify scroll bottom state');
      assert.deepEqual(error.details, {
        hint: 'scroll bottom needs a snapshot showing hidden content below before it will move.',
      });
      assert.equal(error.cause, original);
      return true;
    },
  );
});

test('captureScrollEdgeState: a captureNodes failure is wrapped in a COMMAND_FAILED AppError, unscoped variant (top edge)', async () => {
  const original = new Error('runner timed out');
  await assert.rejects(
    captureScrollEdgeState({
      edge: 'top',
      captureNodes: async () => {
        throw original;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Failed to verify scroll top state');
      assert.deepEqual(error.details, {
        hint: 'scroll top needs a snapshot showing hidden content above before it will move.',
      });
      assert.equal(error.cause, original);
      return true;
    },
  );
});

async function captureThrows(scope: string | undefined): Promise<AppError> {
  try {
    await captureScrollEdgeState({
      edge: 'bottom',
      scope,
      captureNodes: async () => {
        throw new Error('boom');
      },
    });
    throw new Error('expected captureScrollEdgeState to reject');
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error;
  }
}

test('captureScrollEdgeState: the scoped and unscoped error messages are distinct', async () => {
  const scopedError = await captureThrows('feed');
  const unscopedError = await captureThrows(undefined);
  assert.notEqual(scopedError.message, unscopedError.message);
});

// ---------------------------------------------------------------------------
// runScrollEdgePasses
// ---------------------------------------------------------------------------

test('runScrollEdgePasses: zero passes when the initial capture already cannot scroll', async () => {
  let scrollCalls = 0;
  let captureCalls = 0;
  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async () => {
      captureCalls += 1;
      return { canScroll: false, emptySnapshot: false, signature: 's0' };
    },
    scroll: async () => {
      scrollCalls += 1;
      return 'scrolled';
    },
  });
  assert.deepEqual(result, { passes: 0, result: undefined });
  assert.equal(scrollCalls, 0);
  // No scope was reported, so the pre-loop rescope must NOT fire a second capture.
  assert.equal(captureCalls, 1);
});

test('runScrollEdgePasses: threads the discovered scope into every subsequent capture, and stops once canScroll flips false', async () => {
  const scopeCalls: (string | undefined)[] = [];
  let scrollCalls = 0;
  let captureCalls = 0;

  const result = await runScrollEdgePasses<{ index: number }>({
    edge: 'bottom',
    captureState: async (scope) => {
      scopeCalls.push(scope);
      captureCalls += 1;
      // capture #1: initial unscoped probe discovers the scope.
      // capture #2: immediate rescope before the loop starts.
      // captures #3..#5: one per completed pass; the 5th reports canScroll: false.
      const canScroll = captureCalls < 5;
      return { canScroll, emptySnapshot: false, signature: `s${captureCalls}`, scope: 'feed' };
    },
    scroll: async () => {
      scrollCalls += 1;
      return { index: scrollCalls };
    },
  });

  assert.equal(scrollCalls, 3);
  assert.equal(result.passes, 3);
  assert.deepEqual(result.result, { index: 3 });
  assert.deepEqual(scopeCalls, [undefined, 'feed', 'feed', 'feed', 'feed']);
});

test('runScrollEdgePasses: a scope reported alongside canScroll:false still triggers the pre-loop rescope, but the loop never runs', async () => {
  // The pre-loop rescope only checks state.scope, not state.canScroll — so it fires
  // even though the very first (unscoped) capture already reports canScroll: false.
  const scopeCalls: (string | undefined)[] = [];
  let scrollCalls = 0;
  let captureCalls = 0;

  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async (scope) => {
      scopeCalls.push(scope);
      captureCalls += 1;
      return {
        canScroll: false,
        emptySnapshot: false,
        signature: `s${captureCalls}`,
        scope: 'feed',
      };
    },
    scroll: async () => {
      scrollCalls += 1;
      return 'x';
    },
  });

  assert.deepEqual(scopeCalls, [undefined, 'feed']);
  assert.equal(scrollCalls, 0);
  assert.equal(result.passes, 0);
});

test('runScrollEdgePasses: throws a COMMAND_FAILED AppError once the pass limit is reached while canScroll stays true', async () => {
  let scrollCalls = 0;
  await assert.rejects(
    runScrollEdgePasses({
      edge: 'bottom',
      captureState: async () => ({
        canScroll: true,
        emptySnapshot: false,
        signature: 'unchanging',
      }),
      scroll: async () => {
        scrollCalls += 1;
        return undefined;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(
        error.message,
        'scroll bottom reached the safety limit before the snapshot showed the edge',
      );
      assert.deepEqual(error.details, {
        hint: 'The scoped scroll container still reports hidden content. Use a smaller manual scroll + snapshot loop to inspect the current state.',
      });
      return true;
    },
  );
  assert.equal(scrollCalls, 40);
});

// ---------------------------------------------------------------------------
// Signature determinism (buildScrollStateSignature / roundSignatureNumber /
// SCROLL_SIGNATURE_RECT_PRECISION)
// ---------------------------------------------------------------------------

function plainNodes(rectX: number): (RawSnapshotNode | SnapshotNode)[] {
  return [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Item',
      rect: { x: rectX, y: 40, width: 100, height: 40 },
    },
  ];
}

test('signature: two structurally identical node lists produce the same signature', async () => {
  const a = await capture(plainNodes(20));
  const b = await capture(plainNodes(20));
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, '');
});

test('signature: a materially different rect produces a different signature', async () => {
  const a = await capture(plainNodes(20));
  const b = await capture(plainNodes(21));
  assert.notEqual(a.signature, b.signature);
});

test('signature: rect coordinates round to one decimal place, collapsing sub-precision differences', async () => {
  const a = await capture(plainNodes(1.02));
  const b = await capture(plainNodes(1.04));
  assert.equal(a.signature, b.signature);
});

test('signature: rect coordinates that round to different first-decimal digits differ', async () => {
  const a = await capture(plainNodes(1.04));
  const b = await capture(plainNodes(1.06));
  assert.notEqual(a.signature, b.signature);
});

test('signature: reflects only the scoped container subtree (including a two-hop grandchild), not unrelated siblings', async () => {
  const baseline = [
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
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Row',
      rect: { x: 20, y: 140, width: 300, height: 40 },
    },
    // Grandchild (two parentIndex hops from the container) — proves hasAncestor
    // walks the full chain, not just the immediate parent.
    {
      ref: 'e4',
      index: 3,
      parentIndex: 2,
      type: 'Text',
      label: 'RowLabel',
      rect: { x: 22, y: 142, width: 100, height: 10 },
    },
    {
      ref: 'e5',
      index: 4,
      parentIndex: 0,
      type: 'Button',
      label: 'UnrelatedSibling',
      rect: { x: 0, y: 760, width: 100, height: 30 },
    },
  ];
  const changedSibling = baseline.map((node) =>
    node.index === 4 ? { ...node, rect: { x: 0, y: 761, width: 100, height: 30 } } : node,
  );

  const before = await capture(baseline, 'bottom', { nodeIndex: 1 });
  const after = await capture(changedSibling, 'bottom', { nodeIndex: 1 });

  // Changing the unrelated sibling must not move the scoped signature at all.
  assert.equal(before.signature, after.signature);
  // The scoped signature must actually include the container ITSELF...
  assert.ok(before.signature.includes('ScrollView'));
  // ...and its descendants...
  assert.ok(before.signature.includes('Row'));
  assert.ok(before.signature.includes('RowLabel'));
  // ...and must exclude content that lives outside the container's subtree.
  assert.ok(!before.signature.includes('UnrelatedSibling'));
});

test('signature: y, width, and height each independently affect the signature (not just x)', async () => {
  const base = {
    ref: 'e2',
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Item',
    rect: { x: 20, y: 40, width: 100, height: 40 },
  };
  const baseState = await capture([windowRoot(), base]);

  const yChanged = await capture([windowRoot(), { ...base, rect: { ...base.rect, y: 41 } }]);
  const widthChanged = await capture([
    windowRoot(),
    { ...base, rect: { ...base.rect, width: 101 } },
  ]);
  const heightChanged = await capture([
    windowRoot(),
    { ...base, rect: { ...base.rect, height: 41 } },
  ]);

  assert.notEqual(baseState.signature, yChanged.signature);
  assert.notEqual(baseState.signature, widthChanged.signature);
  assert.notEqual(baseState.signature, heightChanged.signature);
});

test('signature: uses one line per node (row separator is a real newline)', async () => {
  const state = await capture([
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Item',
      rect: { x: 20, y: 40, width: 100, height: 40 },
    },
  ]);
  assert.equal(state.signature.split('\n').length, 2);
});

test('signature: the per-field separator prevents index/parentIndex digit strings from colliding', async () => {
  // Without a separator between fields, "1" + "23" and "12" + "3" both
  // concatenate to "123" — a real separator keeps these distinguishable.
  const a = await capture([{ index: 1, parentIndex: 23 }]);
  const b = await capture([{ index: 12, parentIndex: 3 }]);
  assert.notEqual(a.signature, b.signature);
});

test('signature: index, parentIndex, type, label, and value are embedded verbatim, not blanked to empty', async () => {
  const state = await capture([
    { index: 9, parentIndex: 8, type: 'CustomType', label: 'CustomLabel', value: 'CustomValue' },
  ]);
  assert.ok(state.signature.includes('9'));
  assert.ok(state.signature.includes('8'));
  assert.ok(state.signature.includes('CustomType'));
  assert.ok(state.signature.includes('CustomLabel'));
  assert.ok(state.signature.includes('CustomValue'));
});

test('signature: a missing index still degrades to an empty component instead of throwing', async () => {
  const state = await capture([{ index: undefined as unknown as number, parentIndex: 5 }]);
  assert.equal(state.emptySnapshot, false);
  assert.equal(state.signature, '|5||||');
});

test('signature: a node without a rect contributes an empty rect component', async () => {
  const state = await capture([{ index: 5 }]);
  assert.equal(state.signature, '5|||||');
});

test('signature: rect components are comma-joined in x,y,width,height order', async () => {
  const state = await capture([{ index: 7, rect: { x: 1, y: 2, width: 3, height: 4 } }]);
  assert.ok(state.signature.includes('1.0,2.0,3.0,4.0'));
});

test('signature: a non-finite or non-numeric rect coordinate degrades to an exactly empty component, not raw or placeholder text', async () => {
  // Asserting the precise comma-delimited shape (empty leading component) rather
  // than just "doesn't contain the raw value" — this also pins down that the
  // fallback is genuinely '', not some other non-empty stand-in text.
  const nan = await capture([{ index: 7, rect: { x: Number.NaN, y: 2, width: 3, height: 4 } }]);
  assert.ok(nan.signature.includes('|,2.0,3.0,4.0'));
  assert.ok(!nan.signature.includes('NaN'));

  const infinite = await capture([
    { index: 7, rect: { x: Number.POSITIVE_INFINITY, y: 2, width: 3, height: 4 } },
  ]);
  assert.ok(infinite.signature.includes('|,2.0,3.0,4.0'));
  assert.ok(!infinite.signature.includes('Infinity'));

  const nonNumeric = await capture([
    { index: 7, rect: { x: 'garbage' as unknown as number, y: 2, width: 3, height: 4 } },
  ]);
  assert.ok(nonNumeric.signature.includes('|,2.0,3.0,4.0'));
  assert.ok(!nonNumeric.signature.includes('garbage'));
});

// ---------------------------------------------------------------------------
// containsPoint boundary (inclusive edges, and-of-four rather than or-of-any)
// ---------------------------------------------------------------------------

test('containsPoint: boundary is inclusive on every edge, and requires all four bounds together (not any pair)', async () => {
  const nodes = [
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

// ---------------------------------------------------------------------------
// buildScrollContainerScope: uniqueness across colliding sibling values
// ---------------------------------------------------------------------------

test('duplicate scroll-container labels do not scope edge verification to a child', async () => {
  const scopes: Array<string | undefined> = [];
  const nodes: SnapshotNode[] = [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Automation lab',
      hiddenContentAbove: true,
      rect: { x: 18, y: 178, width: 366, height: 662 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'StaticText',
      label: 'Automation lab',
      rect: { x: 18, y: -344, width: 311, height: 36 },
    },
  ];

  const state = await captureScrollEdgeState({
    edge: 'top',
    captureNodes: async (scope) => {
      scopes.push(scope);
      return nodes;
    },
  });

  assert.equal(state.canScroll, true);
  assert.equal(state.scope, undefined);
  assert.deepEqual(scopes, [undefined]);
});

for (const collision of ['Automation lab details', 'AUTOMATION LAB']) {
  test(`native-style scope collision does not select ${JSON.stringify(collision)}`, async () => {
    const nodes: SnapshotNode[] = [
      {
        index: 1,
        ref: 'e1',
        type: 'ScrollView',
        label: 'Automation lab',
        hiddenContentAbove: true,
        rect: { x: 18, y: 178, width: 366, height: 662 },
      },
      {
        index: 2,
        ref: 'e2',
        parentIndex: 1,
        type: 'StaticText',
        label: collision,
        rect: { x: 18, y: -344, width: 311, height: 36 },
      },
    ];

    const state = await captureScrollEdgeState({
      edge: 'top',
      captureNodes: async () => nodes,
    });

    assert.equal(state.scope, undefined);
  });
}

test('value collision does not scope edge verification to an ambiguous subtree', async () => {
  const nodes: SnapshotNode[] = [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Automation lab',
      hiddenContentAbove: true,
      rect: { x: 18, y: 178, width: 366, height: 662 },
    },
    {
      index: 2,
      ref: 'e2',
      type: 'Other',
      value: 'Automation lab ready',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
  ];

  const state = await captureScrollEdgeState({
    edge: 'top',
    captureNodes: async () => nodes,
  });

  assert.equal(state.scope, undefined);
});

test('unique container scope is retained across edge pass captures', async () => {
  const scopes: Array<string | undefined> = [];
  const snapshots = [scrollSnapshot(true), scrollSnapshot(true), scrollSnapshot(false)];
  let captureIndex = 0;

  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async (scope) =>
      await captureScrollEdgeState({
        edge: 'bottom',
        scope,
        captureNodes: async (capturedScope) => {
          scopes.push(capturedScope);
          return snapshots[Math.min(captureIndex++, snapshots.length - 1)] ?? [];
        },
      }),
    scroll: async () => ({ scrolled: true }),
  });

  assert.equal(result.passes, 1);
  assert.deepEqual(scopes, [undefined, 'Messages', 'Messages']);
});

function scrollSnapshot(hiddenContentBelow: boolean): SnapshotNode[] {
  return [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Messages',
      hiddenContentBelow: hiddenContentBelow ? true : undefined,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'Button',
      label: hiddenContentBelow ? 'Middle message' : 'Latest message',
      rect: { x: 0, y: 640, width: 400, height: 56 },
    },
  ];
}
