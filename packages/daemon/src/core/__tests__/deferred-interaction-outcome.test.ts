import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  isPostGestureStabilizationPending,
  markDeferredInteractionOutcome,
  pendingSurfaceStabilization,
  markPostOpenStabilization,
  resolveDeferredInteractionOutcome,
  stripInternalInteractionFlags,
  type DeferredOutcomeSnapshotAttempt,
} from '../deferred-interaction-outcome.ts';
import type { SessionState } from '../session-state.ts';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  deliverySnapshot,
  makeSession,
  pickupSnapshot,
} from './post-gesture-stabilization-fixtures.ts';

/** A first screen with more than a sparse tree's content: a header and five rows. */
function homeScreenSnapshot(y = 500) {
  return makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Home',
      rect: { x: 20, y: 60, width: 200, height: 30 },
    },
    ...Array.from({ length: 5 }, (_, row) => ({
      index: row + 2,
      parentIndex: 0,
      type: 'Button',
      label: `Row ${row}`,
      rect: { x: 20, y: y + row * 50, width: 300, height: 44 },
    })),
  ]);
}

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

test('an Apple open that could not observe its app marks stabilization without a baseline', () => {
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot();

  markPostOpenStabilization(session, 'unobservable');

  assert.equal(isPostGestureStabilizationPending(session), true);
  assert.equal(pendingSurfaceStabilization(session)?.action, 'open');
  assert.equal(pendingSurfaceStabilization(session)?.baseline?.signature, undefined);
});

test('every open that launched an app marks a first-screen wait, on iOS and Android alike', () => {
  const readiness = (platform: 'ios' | 'android') =>
    (
      [
        'unobservable',
        'probe-failed',
        'app-unidentified',
        'not-eligible',
        'observable',
        undefined,
      ] as const
    ).map((observation) => {
      const session = makeSession(platform);
      markPostOpenStabilization(session, observation);
      return pendingSurfaceStabilization(session)?.readiness;
    });
  const launched = Array.from({ length: 5 }, () => 'first-screen');

  assert.deepEqual(readiness('ios'), [...launched, undefined]);
  assert.deepEqual(readiness('android'), [...launched, undefined]);
});

test('the first capture after an open waits through a loading tree for the first screen', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  markPostOpenStabilization(session, 'observable');
  const loading = makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
  ]);
  const home = homeScreenSnapshot();
  const { capture } = scriptedCapture([loading, loading, loading, loading, loading, home, home]);

  const pendingResult = resolveDeferredInteractionOutcome(resolveParams(session, capture));
  await vi.advanceTimersByTimeAsync(3_000);
  const result = await pendingResult;

  assert.equal(result?.snapshot, home);
  assert.equal(result?.snapshot.postGestureOutcome, undefined);
  assert.equal(isPostGestureStabilizationPending(session), false);
});

test('the first capture after an open marks a tree that never showed a first screen as loading', async () => {
  vi.useFakeTimers();
  const session = makeSession('android');
  markPostOpenStabilization(session, 'observable');
  const { capture } = scriptedCapture([makeSnapshotState([])]);

  const pendingResult = resolveDeferredInteractionOutcome(resolveParams(session, capture));
  await vi.advanceTimersByTimeAsync(11_000);
  const result = await pendingResult;

  assert.equal(result?.snapshot.nodes.length, 0);
  assert.deepEqual(result?.snapshot.postGestureOutcome, {
    kind: 'loading',
    gesture: { action: 'open', positionals: [] },
  });
});

test('the first capture after an unobserved open reads the list where it came to rest', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  markPostOpenStabilization(session, 'unobservable');
  const { capture, calls } = scriptedCapture([
    homeScreenSnapshot(319),
    homeScreenSnapshot(406),
    homeScreenSnapshot(406),
  ]);

  const pendingResult = resolveDeferredInteractionOutcome(resolveParams(session, capture));
  for (let step = 0; step < 10; step += 1) {
    await vi.advanceTimersByTimeAsync(200);
  }
  const result = await pendingResult;

  assert.equal(calls(), 3);
  assert.equal(result?.snapshot.nodes[2]?.rect?.y, 406);
  assert.equal(result?.snapshot.postGestureOutcome, undefined);
  assert.equal(isPostGestureStabilizationPending(session), false);
});

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
