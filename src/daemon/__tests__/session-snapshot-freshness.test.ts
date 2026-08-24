import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';
import {
  clearAndroidSnapshotFreshness,
  getActiveAndroidSnapshotFreshness,
  markAndroidSnapshotFreshness,
} from '../session-snapshot-freshness.ts';
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
