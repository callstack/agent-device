import { test } from 'vitest';
import assert from 'node:assert/strict';
import { capture, scrollNode, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// selectScrollContainer: broad selection (no target), multiple scrollables
// ---------------------------------------------------------------------------

test('selectScrollContainer (broad): among containers with a hidden edge, the largest one wins', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, {
      identifier: 'small-hidden',
      hiddenContentBelow: true,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    }),
    scrollNode(2, {
      identifier: 'large-hidden',
      hiddenContentBelow: true,
      rect: { x: 0, y: 200, width: 300, height: 300 },
    }),
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.scope, 'large-hidden');
});

test('selectScrollContainer (broad): edge verification follows the viewport-centered gesture instead of an off-center hidden-edge child', async () => {
  const nodes = [
    windowRoot(),
    scrollNode(1, {
      identifier: 'settings-table',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    }),
    scrollNode(2, {
      identifier: 'profile-picture-scroll',
      hiddenContentAbove: true,
      hiddenContentBelow: true,
      rect: { x: 300, y: 120, width: 80, height: 80 },
    }),
  ];

  const state = await capture(nodes, 'top');

  assert.equal(state.canScroll, false);
  assert.equal(state.scope, 'settings-table');
});

test('selectScrollContainer (broad): with no hidden edge anywhere, the LARGEST visible-in-viewport container wins, not just the first visible one', async () => {
  // Declaration order deliberately disagrees with area order (visible-small is
  // declared first) so a sort-less "first visible" implementation would pick
  // the wrong one; offscreen-huge is bigger still but must be excluded by the
  // visibility filter entirely.
  const nodes = [
    windowRoot(),
    scrollNode(1, { identifier: 'visible-small', rect: { x: 0, y: 0, width: 50, height: 50 } }),
    scrollNode(2, { identifier: 'visible-large', rect: { x: 0, y: 0, width: 200, height: 200 } }),
    scrollNode(3, {
      identifier: 'offscreen-huge',
      rect: { x: -5000, y: 0, width: 1000, height: 1000 },
    }),
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
    scrollNode(1, {
      identifier: 'offscreen-small',
      rect: { x: -2000, y: 0, width: 100, height: 100 },
    }),
    scrollNode(2, {
      identifier: 'offscreen-large',
      rect: { x: -1000, y: 0, width: 300, height: 300 },
    }),
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.scope, 'offscreen-large');
});
