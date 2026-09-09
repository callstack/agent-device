import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  SCROLL_UNTIL_PASS_LIMIT,
  formatScrollUntilMessage,
  runScrollUntilVisiblePasses,
  scrollUntilNotFoundError,
} from '../scroll-until-visible.ts';

/** A tree the edge analyzer reads as "more content below": a scrollable with a clipped child. */
function scrollableTree(childY: number): SnapshotNode[] {
  return [
    {
      index: 0,
      ref: 'e1',
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    } as SnapshotNode,
    {
      index: 1,
      parentIndex: 0,
      ref: 'e2',
      type: 'ScrollView',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    } as SnapshotNode,
    {
      index: 2,
      parentIndex: 1,
      ref: 'e3',
      type: 'TextField',
      rect: { x: 0, y: childY, width: 400, height: 40 },
    } as SnapshotNode,
  ];
}

test('a target that is already visible costs one capture and zero scrolls', async () => {
  let scrolls = 0;
  const outcome = await runScrollUntilVisiblePasses({
    edge: 'bottom',
    captureNodes: async () => scrollableTree(100),
    isVisibleMatch: () => true,
    scroll: async () => {
      scrolls += 1;
      return { scrolled: true };
    },
  });
  assert.equal(outcome.outcome, 'matched');
  assert.equal(outcome.passes, 0);
  assert.equal(scrolls, 0);
});

test('passes repeat until the injected predicate reports the target on screen', async () => {
  let scrolls = 0;
  const outcome = await runScrollUntilVisiblePasses({
    edge: 'bottom',
    captureNodes: async () => scrollableTree(2000),
    isVisibleMatch: () => scrolls >= 3,
    scroll: async () => {
      scrolls += 1;
      return { pixels: 250 };
    },
  });
  assert.equal(outcome.outcome, 'matched');
  assert.equal(outcome.passes, 3);
  assert.deepEqual(outcome.result, { pixels: 250 });
});

test('running out of content stops the loop before the pass budget does', async () => {
  let scrolls = 0;
  const outcome = await runScrollUntilVisiblePasses({
    edge: 'bottom',
    // No child below the fold: the edge analyzer reports nothing hidden underneath.
    captureNodes: async () => scrollableTree(100),
    isVisibleMatch: () => false,
    scroll: async () => {
      scrolls += 1;
      return {};
    },
  });
  assert.equal(outcome.outcome, 'edge-reached');
  assert.equal(scrolls, 0);
});

test('a horizontal scroll has no edge signal and is bounded by the pass budget alone', async () => {
  let scrolls = 0;
  const outcome = await runScrollUntilVisiblePasses({
    passLimit: 4,
    captureNodes: async () => scrollableTree(100),
    isVisibleMatch: () => false,
    scroll: async () => {
      scrolls += 1;
      return {};
    },
  });
  assert.equal(outcome.outcome, 'pass-limit');
  assert.equal(outcome.passes, 4);
  assert.equal(scrolls, 4);
});

test('the default pass budget is the shared constant', async () => {
  const outcome = await runScrollUntilVisiblePasses({
    captureNodes: async () => scrollableTree(100),
    isVisibleMatch: () => false,
    scroll: async () => ({}),
  });
  assert.equal(outcome.passes, SCROLL_UNTIL_PASS_LIMIT);
});

test('an empty capture never counts as a match', async () => {
  const outcome = await runScrollUntilVisiblePasses({
    passLimit: 1,
    captureNodes: async () => [],
    isVisibleMatch: (nodes) => nodes.length > 0,
    scroll: async () => ({}),
  });
  assert.equal(outcome.outcome, 'pass-limit');
});

test('the success message distinguishes an already-visible target from a scrolled one', () => {
  assert.equal(
    formatScrollUntilMessage('down', 'id=email', 0),
    'id=email was already visible; no down scroll needed',
  );
  assert.equal(
    formatScrollUntilMessage('down', 'id=email', 1),
    'Scrolled down 1 pass until id=email was visible',
  );
  assert.equal(
    formatScrollUntilMessage('down', 'id=email', 3),
    'Scrolled down 3 passes until id=email was visible',
  );
});

test('the two failures carry distinct typed reasons and distinct corrective hints', () => {
  const edge = scrollUntilNotFoundError({
    direction: 'down',
    selector: 'id=email',
    outcome: 'edge-reached',
    passes: 2,
  });
  const budget = scrollUntilNotFoundError({
    direction: 'down',
    selector: 'id=email',
    outcome: 'pass-limit',
    passes: 12,
  });
  assert.equal(edge.details?.reason, 'scroll_until_edge_reached');
  assert.equal(budget.details?.reason, 'scroll_until_pass_limit');
  assert.match(String(edge.details?.hint), /scroll the opposite direction/);
  assert.match(String(budget.details?.hint), /Raise the step with an amount/);
});
