import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';
import {
  androidFreshnessReason,
  buildSnapshotSignatures,
  isLikelySnapshotStuckOnPreviousRoute,
  isLikelyStaleSnapshotDrop,
} from '../snapshot-freshness/android.ts';
import type { SnapshotFreshnessWindow } from '../snapshot-freshness/index.ts';

function labeledNodes(count: number, prefix = 'item'): RawSnapshotNode[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    type: 'Button',
    label: `${prefix}-${index}`,
  }));
}

function anonymousNodes(count: number): RawSnapshotNode[] {
  return Array.from({ length: count }, (_, index) => ({ index, type: 'View' }));
}

function freshnessWindow(
  overrides: Partial<SnapshotFreshnessWindow> = {},
): SnapshotFreshnessWindow {
  return {
    action: 'click',
    markedAt: Date.now(),
    baselineCount: 50,
    routeComparable: false,
    ...overrides,
  };
}

// --- androidFreshnessReason: the whole three-reason classification ---

test('empty interactive capture over a dozen raw nodes reads as a transitional frame', () => {
  const reason = androidFreshnessReason(
    { snapshot: makeSnapshotState([]), rawNodeCount: 12 },
    freshnessWindow(),
    { interactiveOnly: true },
  );
  assert.equal(reason, 'empty-interactive');
});

test('empty interactive capture stays trusted below the raw-node floor or without disclosure', () => {
  const belowFloor = androidFreshnessReason(
    { snapshot: makeSnapshotState([]), rawNodeCount: 11 },
    freshnessWindow({ baselineCount: 0 }),
    { interactiveOnly: true },
  );
  const undisclosed = androidFreshnessReason(
    { snapshot: makeSnapshotState([]), rawNodeCount: undefined },
    freshnessWindow({ baselineCount: 0 }),
    { interactiveOnly: true },
  );
  assert.equal(belowFloor, null);
  assert.equal(undisclosed, null);
});

test('ref-refresh mode only ever reports the empty-interactive shape', () => {
  const suppressed = androidFreshnessReason(
    { snapshot: makeSnapshotState(anonymousNodes(3)), rawNodeCount: undefined },
    freshnessWindow({ baselineCount: 50 }),
    { interactiveOnly: false, mode: 'ref-refresh' },
  );
  assert.equal(suppressed, null);
});

test('a sharp node-count drop with no meaningful content reads as stale', () => {
  const reason = androidFreshnessReason(
    { snapshot: makeSnapshotState(anonymousNodes(3)), rawNodeCount: undefined },
    freshnessWindow({ baselineCount: 50 }),
    { interactiveOnly: false },
  );
  assert.equal(reason, 'sharp-drop');
});

test('a sharp drop onto a screen with real content is trusted (deliberately minimal screens)', () => {
  const reason = androidFreshnessReason(
    { snapshot: makeSnapshotState(labeledNodes(3)), rawNodeCount: undefined },
    freshnessWindow({ baselineCount: 50 }),
    { interactiveOnly: false },
  );
  assert.equal(reason, null);
});

test('a near-identical tree after a navigation-sensitive action reads as stuck on the previous route', () => {
  const nodes = labeledNodes(20);
  const baseline = makeSnapshotState(nodes);
  const reason = androidFreshnessReason(
    { snapshot: makeSnapshotState(nodes), rawNodeCount: undefined },
    freshnessWindow({
      baselineCount: baseline.nodes.length,
      baselineSignatures: buildSnapshotSignatures(baseline.nodes),
      routeComparable: true,
    }),
    { interactiveOnly: false },
  );
  assert.equal(reason, 'stuck-route');
});

test('stuck-route never fires without a route-comparable baseline or for a non-navigation action', () => {
  const nodes = labeledNodes(20);
  const signatures = buildSnapshotSignatures(makeSnapshotState(nodes).nodes);
  const notComparable = androidFreshnessReason(
    { snapshot: makeSnapshotState(nodes), rawNodeCount: undefined },
    freshnessWindow({ baselineCount: 20, baselineSignatures: signatures, routeComparable: false }),
    { interactiveOnly: false },
  );
  const steadyStateAction = androidFreshnessReason(
    { snapshot: makeSnapshotState(nodes), rawNodeCount: undefined },
    freshnessWindow({
      action: 'type',
      baselineCount: 20,
      baselineSignatures: signatures,
      routeComparable: true,
    }),
    { interactiveOnly: false },
  );
  assert.equal(notComparable, null);
  assert.equal(steadyStateAction, null);
});

test('a genuinely new route is trusted', () => {
  const baseline = makeSnapshotState(labeledNodes(20, 'catalog'));
  const reason = androidFreshnessReason(
    { snapshot: makeSnapshotState(labeledNodes(20, 'checkout')), rawNodeCount: undefined },
    freshnessWindow({
      baselineCount: baseline.nodes.length,
      baselineSignatures: buildSnapshotSignatures(baseline.nodes),
      routeComparable: true,
    }),
    { interactiveOnly: false },
  );
  assert.equal(reason, null);
});

// --- the underlying predicates ---

test('isLikelyStaleSnapshotDrop needs both the 12-node floor and the 20% ratio', () => {
  assert.equal(isLikelyStaleSnapshotDrop(11, 0), false);
  assert.equal(isLikelyStaleSnapshotDrop(50, 10), true);
  assert.equal(isLikelyStaleSnapshotDrop(50, 11), false);
});

test('isLikelySnapshotStuckOnPreviousRoute ignores missing baselines and tiny trees', () => {
  const nodes = makeSnapshotState(labeledNodes(20)).nodes;
  assert.equal(isLikelySnapshotStuckOnPreviousRoute(undefined, nodes), false);
  assert.equal(isLikelySnapshotStuckOnPreviousRoute([], nodes), false);
  const tiny = makeSnapshotState(labeledNodes(5)).nodes;
  assert.equal(isLikelySnapshotStuckOnPreviousRoute(buildSnapshotSignatures(tiny), tiny), false);
});
