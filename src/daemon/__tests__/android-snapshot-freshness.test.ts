import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '../../__tests__/test-utils/index.ts';
import {
  buildSnapshotSignatures,
  clearAndroidSnapshotFreshness,
  getActiveAndroidSnapshotFreshness,
  getAndroidFreshnessReason,
  isLikelySnapshotStuckOnPreviousRoute,
  isLikelyStaleSnapshotDrop,
  markAndroidSnapshotFreshness,
  type AndroidSnapshotFreshness,
} from '../android-snapshot-freshness.ts';
import { makeSession } from './post-gesture-stabilization-fixtures.ts';

afterEach(() => {
  vi.useRealTimers();
});

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

function freshnessRecord(
  overrides: Partial<AndroidSnapshotFreshness> = {},
): AndroidSnapshotFreshness {
  return {
    action: 'click',
    markedAt: Date.now(),
    baselineCount: 50,
    routeComparable: false,
    ...overrides,
  };
}

// --- getAndroidFreshnessReason: the whole three-reason classification ---

test('empty interactive capture over a dozen raw nodes reads as a transitional frame', () => {
  const reason = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState([]), rawNodeCount: 12 },
    freshnessRecord(),
    { interactiveOnly: true },
  );
  assert.equal(reason, 'empty-interactive');
});

test('empty interactive capture stays trusted below the raw-node floor or without disclosure', () => {
  const belowFloor = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState([]), rawNodeCount: 11 },
    freshnessRecord({ baselineCount: 0 }),
    { interactiveOnly: true },
  );
  const undisclosed = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState([]), rawNodeCount: undefined },
    freshnessRecord({ baselineCount: 0 }),
    { interactiveOnly: true },
  );
  assert.equal(belowFloor, null);
  assert.equal(undisclosed, null);
});

test('ref-refresh mode only ever reports the empty-interactive shape', () => {
  const suppressed = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState(anonymousNodes(3)), rawNodeCount: undefined },
    freshnessRecord({ baselineCount: 50 }),
    { interactiveOnly: false, mode: 'ref-refresh' },
  );
  assert.equal(suppressed, null);
});

test('a sharp node-count drop with no meaningful content reads as stale', () => {
  const reason = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState(anonymousNodes(3)), rawNodeCount: undefined },
    freshnessRecord({ baselineCount: 50 }),
    { interactiveOnly: false },
  );
  assert.equal(reason, 'sharp-drop');
});

test('a sharp drop onto a screen with real content is trusted (deliberately minimal screens)', () => {
  const reason = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState(labeledNodes(3)), rawNodeCount: undefined },
    freshnessRecord({ baselineCount: 50 }),
    { interactiveOnly: false },
  );
  assert.equal(reason, null);
});

test('a near-identical tree after a navigation-sensitive action reads as stuck on the previous route', () => {
  const nodes = labeledNodes(20);
  const baseline = makeSnapshotState(nodes);
  const reason = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState(nodes), rawNodeCount: undefined },
    freshnessRecord({
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
  const notComparable = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState(nodes), rawNodeCount: undefined },
    freshnessRecord({ baselineCount: 20, baselineSignatures: signatures, routeComparable: false }),
    { interactiveOnly: false },
  );
  const steadyStateAction = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState(nodes), rawNodeCount: undefined },
    freshnessRecord({
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
  const reason = getAndroidFreshnessReason(
    { snapshot: makeSnapshotState(labeledNodes(20, 'checkout')), rawNodeCount: undefined },
    freshnessRecord({
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

// --- mark / get / clear lifecycle ---

test('mark records a route-comparable baseline only from a comparison-safe snapshot', () => {
  const session = makeSession('android');
  session.snapshot = makeSnapshotState(labeledNodes(20), { comparisonSafe: true });

  markAndroidSnapshotFreshness(session, 'click');

  assert.equal(session.androidSnapshotFreshness?.routeComparable, true);
  assert.equal(session.androidSnapshotFreshness?.baselineSignatures?.length, 20);
});

test('mark keeps a pruned baseline usable for count comparison but not route comparison', () => {
  const session = makeSession('android');
  session.snapshot = makeSnapshotState(labeledNodes(20));

  markAndroidSnapshotFreshness(session, 'click');

  assert.equal(session.androidSnapshotFreshness?.routeComparable, false);
  assert.equal(session.androidSnapshotFreshness?.baselineSignatures, undefined);
  assert.equal(session.androidSnapshotFreshness?.baselineCount, 20);
});

test('mark is Android-only and the active window expires', () => {
  vi.useFakeTimers();
  const iosSession = makeSession('ios');
  markAndroidSnapshotFreshness(iosSession, 'click');
  assert.equal(iosSession.androidSnapshotFreshness, undefined);

  const session = makeSession('android');
  markAndroidSnapshotFreshness(session, 'click');
  assert.ok(getActiveAndroidSnapshotFreshness(session));

  vi.advanceTimersByTime(2_501);
  assert.equal(getActiveAndroidSnapshotFreshness(session), undefined);
  assert.equal(session.androidSnapshotFreshness, undefined);
});

test('clear removes an active freshness window', () => {
  const session = makeSession('android');
  markAndroidSnapshotFreshness(session, 'click');
  clearAndroidSnapshotFreshness(session);
  assert.equal(session.androidSnapshotFreshness, undefined);
});
