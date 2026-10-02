import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  isPostGestureStabilizationPending,
  markDeferredInteractionOutcome,
  resolveDeferredInteractionOutcome,
  stripInternalInteractionFlags,
  type DeferredOutcomeSnapshotAttempt,
} from '../deferred-interaction-outcome.ts';
import type { SessionState } from '../session-state.ts';
import {
  deliverySnapshot,
  makeSession,
  pickupSnapshot,
} from './post-gesture-stabilization-fixtures.ts';

afterEach(() => {
  vi.useRealTimers();
});

function scriptedCapture(snapshots: ReturnType<typeof pickupSnapshot>[]): {
  capture: () => Promise<DeferredOutcomeSnapshotAttempt>;
  calls: () => number;
} {
  let callCount = 0;
  return {
    capture: async () => {
      const snapshot = snapshots[Math.min(callCount, snapshots.length - 1)];
      callCount += 1;
      if (!snapshot) throw new Error('scripted capture exhausted');
      return { snapshot, annotations: {} };
    },
    calls: () => callCount,
  };
}

function resolveParams(
  session: SessionState,
  capture: () => Promise<DeferredOutcomeSnapshotAttempt>,
) {
  return {
    session,
    device: session.device,
    interactiveOnly: false,
    capture,
  };
}

// --- mutation-side marking ---

test('marking is one call for both flags, each keeping its own eligibility gate', () => {
  const session = makeSession('android');
  session.snapshot = pickupSnapshot();

  markDeferredInteractionOutcome({
    session,
    command: 'click',
    positionals: ['100', '200'],
    flags: undefined,
  });

  assert.equal(session.androidSnapshotFreshness?.action, 'click');
  // click is not a stabilizing gesture — its gate declines independently.
  assert.equal(isPostGestureStabilizationPending(session), false);
});

test('a scroll marks stabilization but not freshness', () => {
  const session = makeSession('android');
  session.snapshot = pickupSnapshot();

  markDeferredInteractionOutcome({
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: undefined,
  });

  assert.equal(isPostGestureStabilizationPending(session), true);
  assert.equal(session.androidSnapshotFreshness, undefined);
});

test('freshness and stabilization eligibility read the action, not the outer command', () => {
  const session = makeSession('android');
  session.snapshot = pickupSnapshot();

  markDeferredInteractionOutcome({
    session,
    command: 'gesture',
    action: 'swipe',
    positionals: [],
    flags: undefined,
  });

  assert.equal(isPostGestureStabilizationPending(session), true);
  assert.equal(session.androidSnapshotFreshness, undefined);
});

// --- capture-side resolution ---

test('nothing deferred resolves to undefined without capturing', async () => {
  const session = makeSession('ios');
  const { capture, calls } = scriptedCapture([pickupSnapshot()]);

  const result = await resolveDeferredInteractionOutcome(resolveParams(session, capture));

  assert.equal(result, undefined);
  assert.equal(calls(), 0);
});

test('a pending stabilization resolves through the quiet-window loop and clears itself', async () => {
  vi.useFakeTimers();
  const session = makeSession('android');
  session.snapshot = pickupSnapshot();
  markDeferredInteractionOutcome({
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: undefined,
  });
  const { capture, calls } = scriptedCapture([deliverySnapshot()]);

  const pendingResult = resolveDeferredInteractionOutcome(resolveParams(session, capture));
  for (let step = 0; step < 10; step += 1) {
    await vi.advanceTimersByTimeAsync(200);
  }
  const result = await pendingResult;

  assert.ok(result?.snapshot);
  assert.ok(calls() >= 2, `expected the loop to poll at least twice, saw ${calls()}`);
  assert.equal(isPostGestureStabilizationPending(session), false);
  assert.equal(result?.warnings, undefined);
});

test('a proven no-effect gesture is stamped on the resolved capture tree (iOS accept-stale)', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot();
  markDeferredInteractionOutcome({
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: undefined,
  });
  // Every post-gesture capture still matches the pre-gesture baseline.
  const { capture } = scriptedCapture([pickupSnapshot()]);

  const pendingResult = resolveDeferredInteractionOutcome(resolveParams(session, capture));
  for (let step = 0; step < 30; step += 1) {
    await vi.advanceTimersByTimeAsync(200);
  }
  const result = await pendingResult;

  assert.deepEqual(result?.snapshot.postGestureOutcome, {
    kind: 'no-effect',
    gesture: { action: 'scroll', positionals: ['down'] },
  });
  assert.equal(isPostGestureStabilizationPending(session), false);
});

test('android freshness recovery re-captures past a stale dump and clears the window', async () => {
  vi.useFakeTimers();
  const session = makeSession('android');
  session.snapshot = pickupSnapshot();
  // A comparison-safe 20-node baseline so the sharp-drop ratio can fire.
  const baseline = pickupSnapshot();
  baseline.nodes = Array.from({ length: 20 }, (_, index) => ({
    ref: `e${index}`,
    index,
    type: 'Button',
    label: `item-${index}`,
  }));
  baseline.comparisonSafe = true;
  session.snapshot = baseline;
  markDeferredInteractionOutcome({
    session,
    command: 'click',
    positionals: ['100', '200'],
    flags: undefined,
  });
  // First capture: 2 anonymous nodes (sharp drop, no content) → suspicious.
  const staleDump = pickupSnapshot();
  staleDump.nodes = [
    { ref: 'e0', index: 0, type: 'View' },
    { ref: 'e1', index: 1, type: 'View' },
  ];
  const { capture, calls } = scriptedCapture([staleDump, deliverySnapshot()]);

  const pendingResult = resolveDeferredInteractionOutcome(resolveParams(session, capture));
  for (let step = 0; step < 10; step += 1) {
    await vi.advanceTimersByTimeAsync(250);
  }
  const result = await pendingResult;

  assert.equal(calls(), 2);
  assert.equal(result?.freshness?.retryCount, 1);
  assert.equal(result?.freshness?.staleAfterRetries, false);
  assert.equal(session.androidSnapshotFreshness, undefined);
});

test('stripInternalInteractionFlags removes internal interaction controls', () => {
  assert.deepEqual(
    stripInternalInteractionFlags({
      platform: 'ios',
      postGestureStabilization: true,
    }),
    { platform: 'ios' },
  );
});
