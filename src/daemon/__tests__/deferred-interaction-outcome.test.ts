import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  isPostGestureStabilizationPending,
  markDeferredInteractionOutcome,
  resolveDeferredInteractionOutcome,
  type DeferredOutcomeSnapshotAttempt,
} from '../deferred-interaction-outcome.ts';
import type { SessionState } from '../types.ts';
import {
  deliverySnapshot,
  makeSession,
  pickupSnapshot,
} from './post-gesture-stabilization-fixtures.ts';

// The one device boundary in this cluster: pending-outcome retries re-dispatch
// the recorded tap through core dispatch. Everything else runs real.
vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});
const { dispatchCommand } = await import('../../core/dispatch.ts');
const dispatchMock = vi.mocked(dispatchCommand);

afterEach(() => {
  vi.useRealTimers();
  dispatchMock.mockClear();
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
    logPath: '/tmp/agent-device-test.log',
    interactiveOnly: false,
    capture,
  };
}

// --- mutation-side marking ---

test('marking is one call for all three flags, each keeping its own eligibility gate', () => {
  const session = makeSession('android');
  session.snapshot = pickupSnapshot();

  markDeferredInteractionOutcome({
    session,
    command: 'click',
    positionals: ['100', '200'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
    scheduleOutcomeRetry: true,
  });

  assert.equal(session.pendingInteractionOutcome?.command, 'press');
  assert.equal(session.androidSnapshotFreshness?.action, 'click');
  // click is not a stabilizing gesture — its gate declines independently.
  assert.equal(isPostGestureStabilizationPending(session), false);
});

test('a scroll marks stabilization but neither retry nor freshness', () => {
  const session = makeSession('android');
  session.snapshot = pickupSnapshot();

  markDeferredInteractionOutcome({
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: undefined,
  });

  assert.equal(isPostGestureStabilizationPending(session), true);
  assert.equal(session.pendingInteractionOutcome, undefined);
  assert.equal(session.androidSnapshotFreshness, undefined);
});

test('outcome retry is never scheduled unless the caller asks', () => {
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot();

  markDeferredInteractionOutcome({
    session,
    command: 'click',
    positionals: ['100', '200'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
  });

  assert.equal(session.pendingInteractionOutcome, undefined);
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

test('an unchanged surface retries the recorded tap once, then settles on the changed capture', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot();
  markDeferredInteractionOutcome({
    session,
    command: 'click',
    positionals: ['100', '200'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
    scheduleOutcomeRetry: true,
  });
  // capture 1+2: still the pre-action surface (delayed-change recheck fires);
  // capture 3: the surface the retried tap produced.
  const { capture } = scriptedCapture([pickupSnapshot(), pickupSnapshot(), deliverySnapshot()]);

  const pendingResult = resolveDeferredInteractionOutcome(resolveParams(session, capture));
  for (let step = 0; step < 10; step += 1) {
    await vi.advanceTimersByTimeAsync(500);
  }
  const result = await pendingResult;

  assert.equal(dispatchMock.mock.calls.length, 1);
  assert.equal(dispatchMock.mock.calls[0]?.[1], 'press');
  assert.equal(
    result?.snapshot.nodes.some((node) => node.identifier === 'shipping-delivery'),
    true,
  );
  assert.equal(session.pendingInteractionOutcome, undefined);
});

test('a changed surface settles immediately with no retry dispatch', async () => {
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot();
  markDeferredInteractionOutcome({
    session,
    command: 'press',
    positionals: ['100', '200'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
    scheduleOutcomeRetry: true,
  });
  const { capture, calls } = scriptedCapture([deliverySnapshot()]);

  const result = await resolveDeferredInteractionOutcome(resolveParams(session, capture));

  assert.equal(dispatchMock.mock.calls.length, 0);
  assert.equal(calls(), 1);
  assert.ok(result?.snapshot);
  assert.equal(session.pendingInteractionOutcome, undefined);
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

test('a proven no-effect gesture surfaces its warning on the resolved capture (iOS accept-stale)', async () => {
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

  assert.equal(result?.warnings?.length, 1);
  assert.match(result?.warnings?.[0] ?? '', /produced no visible change/);
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
