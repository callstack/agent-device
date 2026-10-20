import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { SnapshotFreshnessAttemptShape } from '@agent-device/capture-kit/snapshot-freshness';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  clearAndroidSnapshotFreshness,
  getActiveAndroidSnapshotFreshness,
  markAndroidSnapshotFreshness,
  captureAndroidFreshnessRecoveredAttempt,
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

test.each(['complete', 'truncated', 'missing-root', 'unknown-cache'] as const)(
  'freshness trusts only complete cache-invalidated acquisitions: %s',
  async (mode) => {
    vi.useFakeTimers();
    const session = makeSession('android');
    session.snapshot = makeSnapshotState(labeledNodes(40), { comparisonSafe: true });
    markAndroidSnapshotFreshness(session, 'press');
    let captures = 0;
    const result = captureAndroidFreshnessRecoveredAttempt(
      {
        session,
        interactiveOnly: false,
        capture: async () => {
          captures++;
          return {
            snapshot: session.snapshot!,
            annotations: {
              androidSnapshot: {
                backend: 'android-helper' as const,
                rootPresent: true,
                cacheInvalidated: mode !== 'unknown-cache',
                helperTruncated: mode === 'truncated',
                missingRootWindowTypes: mode === 'missing-root' ? [1] : [],
              },
            },
          };
        },
      },
      session.androidSnapshotFreshness!,
    );
    await vi.runAllTimersAsync();
    const capture: SnapshotFreshnessAttemptShape = await result;
    assert.equal(captures, mode === 'complete' ? 1 : 4);
    assert.equal(
      capture.annotations.freshness?.staleAfterRetries,
      mode === 'complete' ? undefined : true,
    );
  },
);
