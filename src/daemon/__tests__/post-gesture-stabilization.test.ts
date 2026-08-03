import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSnapshotState } from '../../__tests__/test-utils/index.ts';
import { countDiagnosticEventsByPhase, withDiagnosticsScope } from '../../utils/diagnostics.ts';
import { buildInteractionSurfaceSignature } from '../interaction-outcome-policy.ts';
import {
  capturePostGestureStabilizedResult,
  decidePostGestureStabilityVerdict,
  markPostGestureStabilization,
} from '../post-gesture-stabilization.ts';
import type { SessionState } from '../types.ts';

afterEach(() => {
  vi.useRealTimers();
});

test('markPostGestureStabilization marks iOS swipe sessions', () => {
  const session = makeSession();

  markPostGestureStabilization(session, 'swipe');

  assert.equal(session.postGestureStabilization?.action, 'swipe');
});

test('markPostGestureStabilization marks Android swipe sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'swipe');

  assert.equal(session.postGestureStabilization?.action, 'swipe');
});

test('markPostGestureStabilization marks gesture swipe sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'gesture', ['swipe', 'left']);

  assert.equal(session.postGestureStabilization?.action, 'gesture');
});

test('markPostGestureStabilization honors an explicit opt-out', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'swipe', [], { postGestureStabilization: false });

  assert.equal(session.postGestureStabilization, undefined);
});

test('markPostGestureStabilization ignores non-swipe gesture sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'gesture', ['pinch', 'in']);

  assert.equal(session.postGestureStabilization, undefined);
});

// ---------------------------------------------------------------------------
// #1542 defect 2: baseline-comparison distrust.
//
// After an AX-free synthesized gesture, XCTest's AX tree isn't proactively
// resynced by the synthesized touch, so it can serve a stale-but-internally-
// consistent read: two consecutive polls agree with each other while still
// exactly matching the PRE-gesture tree. `decidePostGestureStabilityVerdict`
// is the pure decision that catches this; the tests below are its exhaustive
// truth table.
// ---------------------------------------------------------------------------

test('markPostGestureStabilization captures the pre-gesture baseline signature on iOS', () => {
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-pickup',
      label: 'Pickup',
      rect: { x: 20, y: 500, width: 200, height: 44 },
    },
  ]);

  markPostGestureStabilization(session, 'scroll');

  assert.deepEqual(
    session.postGestureStabilization?.baselineSignature,
    buildInteractionSurfaceSignature(session.snapshot.nodes),
  );
  assert.ok((session.postGestureStabilization?.baselineSignature?.length ?? 0) > 0);
});

test('markPostGestureStabilization does not compute a baseline signature on Android', () => {
  const session = makeSession('android');
  session.snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'android.widget.Button',
      label: 'Pickup',
      rect: { x: 20, y: 500, width: 200, height: 44 },
    },
  ]);

  markPostGestureStabilization(session, 'scroll');

  assert.equal(session.postGestureStabilization?.baselineSignature, undefined);
});

test('markPostGestureStabilization tolerates a missing pre-gesture snapshot on iOS', () => {
  const session = makeSession('ios');

  markPostGestureStabilization(session, 'scroll');

  assert.deepEqual(session.postGestureStabilization?.baselineSignature, []);
});

test('decidePostGestureStabilityVerdict trusts immediately when the platform does not need baseline distrust', () => {
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);

  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: false,
      baselineSignature: signature,
      quietSignature: signature,
      elapsedMs: 0,
      distrustCapMs: 3_500,
    }),
    'trust',
  );
});

test('decidePostGestureStabilityVerdict trusts when there is no usable baseline', () => {
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);

  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: undefined,
      quietSignature: signature,
      elapsedMs: 0,
      distrustCapMs: 3_500,
    }),
    'trust',
  );
  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: [],
      quietSignature: signature,
      elapsedMs: 0,
      distrustCapMs: 3_500,
    }),
    'trust',
  );
});

test('decidePostGestureStabilityVerdict trusts a quiet signature that differs from the baseline', () => {
  const baseline = buildInteractionSurfaceSignature(pickupSnapshot(500).nodes);
  const moved = buildInteractionSurfaceSignature(pickupSnapshot(120).nodes);

  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: baseline,
      quietSignature: moved,
      elapsedMs: 0,
      distrustCapMs: 3_500,
    }),
    'trust',
  );
});

test('decidePostGestureStabilityVerdict distrusts a quiet signature matching the baseline before the cap', () => {
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);

  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: signature,
      quietSignature: signature,
      elapsedMs: 3_499,
      distrustCapMs: 3_500,
    }),
    'distrust',
  );
});

test('decidePostGestureStabilityVerdict accepts a baseline-matching signature once the cap expires', () => {
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);

  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: signature,
      quietSignature: signature,
      elapsedMs: 3_500,
      distrustCapMs: 3_500,
    }),
    'accept-stale',
  );
  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: signature,
      quietSignature: signature,
      elapsedMs: 9_000,
      distrustCapMs: 3_500,
    }),
    'accept-stale',
  );
});

// ---------------------------------------------------------------------------
// capturePostGestureStabilizedResult: the async loop wired to the pure
// decision above. Fake timers keep these instant despite the real 200ms poll
// interval and (for the distrust path) the 3.5s cap.
// ---------------------------------------------------------------------------

test('capturePostGestureStabilizedResult keeps polling past the normal deadline when the AX tree is stuck at the pre-gesture baseline (iOS)', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot(500);
  markPostGestureStabilization(session, 'scroll');

  let captureCount = 0;
  const capture = vi.fn(async () => {
    captureCount += 1;
    return pickupSnapshot(500); // identical to the pre-gesture baseline, every time
  });

  const resultPromise = withDiagnosticsScope({}, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      settled: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilized']),
    };
  });

  await vi.advanceTimersByTimeAsync(10_000);
  const { staleAccepts, settled } = await resultPromise;

  assert.equal(staleAccepts, 1);
  assert.equal(settled, 0);
  assert.equal(session.postGestureStabilization, undefined);
  // Proves it kept polling well past the OLD 1.5s accept point (2 attempts,
  // ~200ms) instead of trusting the first quiet match.
  assert.ok(captureCount > 8, `expected sustained polling, saw ${captureCount} captures`);
});

test('capturePostGestureStabilizedResult trusts a quiet signature once content genuinely differs from the baseline (iOS)', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot(500); // pre-gesture: Pickup below the fold
  markPostGestureStabilization(session, 'scroll');

  const capture = vi.fn(async () => pickupSnapshot(120)); // post-gesture: scrolled into view, every read agrees

  const resultPromise = withDiagnosticsScope({}, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      settled: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilized']),
    };
  });

  await vi.advanceTimersByTimeAsync(1_000);
  const { staleAccepts, settled } = await resultPromise;

  assert.equal(settled, 1);
  assert.equal(staleAccepts, 0);
  // Accepted at the first quiet match (initial capture + one poll = 2
  // attempts): no distrust cost for a genuine settle.
  assert.equal(capture.mock.calls.length, 2);
});

test('capturePostGestureStabilizedResult trusts an Android baseline match immediately (no distrust cost)', async () => {
  vi.useFakeTimers();
  const session = makeSession('android');
  session.snapshot = pickupSnapshot(500);
  markPostGestureStabilization(session, 'scroll');
  assert.equal(session.postGestureStabilization?.baselineSignature, undefined);

  const capture = vi.fn(async () => pickupSnapshot(500)); // identical throughout, like the iOS stale case

  const resultPromise = withDiagnosticsScope({}, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      settled: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilized']),
    };
  });

  await vi.advanceTimersByTimeAsync(1_000);
  const { staleAccepts, settled } = await resultPromise;

  assert.equal(settled, 1);
  assert.equal(staleAccepts, 0);
  // Android has no baseline to distrust, so it accepts on the first quiet
  // match (initial capture + one poll = 2 attempts) — Android's latency is
  // untouched by the fix.
  assert.equal(capture.mock.calls.length, 2);
});

test('capturePostGestureStabilizedResult keeps the ordinary never-quiet timeout at the original 1.5s budget (iOS)', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot(500);
  markPostGestureStabilization(session, 'scroll');

  let toggle = 0;
  const capture = vi.fn(async () => {
    toggle += 1;
    // Never quiet: alternates every poll, so consecutive reads never agree.
    return pickupSnapshot(toggle % 2 === 0 ? 120 : 300);
  });

  const resultPromise = withDiagnosticsScope({}, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      timeouts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilization_timeout']),
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
    };
  });

  // Advance just past the original 1.5s deadline (one 200ms poll of slack):
  // if the distrust extension wrongly applied here (it must not — the
  // signature never goes quiet), the loop would still be polling past this
  // point and the assertions below would see zero timeouts instead of one.
  await vi.advanceTimersByTimeAsync(1_700);
  const { timeouts, staleAccepts } = await resultPromise;

  assert.equal(timeouts, 1);
  assert.equal(staleAccepts, 0);
  // 1500ms / 200ms poll interval = 7 loop iterations plus the initial
  // capture: bounded by the ORIGINAL 1.5s deadline, not the 3.5s distrust
  // cap the accept-stale test above needs (>8 captures) to reach its verdict.
  assert.ok(
    capture.mock.calls.length <= 9,
    `expected the original ~1.5s budget, saw ${capture.mock.calls.length} captures`,
  );
});

test('capturePostGestureStabilizedResult catches a frozen target even when the baseline came from a broader-scope capture than the post-gesture reads (iOS, live regression)', async () => {
  // Live shape (checkout-form.ad): the pre-gesture baseline is whatever
  // `session.snapshot` held from an earlier broad capture (e.g. a text-search
  // `wait`), while the post-gesture reads are the click's interactive-only
  // selector-resolution captures — a strictly narrower shape. Both still see
  // the "Pickup" button frozen at the same pre-scroll position.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshotWithExtraText(500);
  markPostGestureStabilization(session, 'scroll');
  assert.ok(
    (session.postGestureStabilization?.baselineSignature?.length ?? 0) >
      buildInteractionSurfaceSignature(pickupSnapshot(500).nodes).length,
    'the baseline must carry the extra text entry the post-gesture reads never see',
  );

  const capture = vi.fn(async () => pickupSnapshot(500)); // narrower shape, same frozen position

  const resultPromise = withDiagnosticsScope({}, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      settled: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilized']),
    };
  });

  await vi.advanceTimersByTimeAsync(10_000);
  const { staleAccepts, settled } = await resultPromise;

  // A whole-array baseline comparison would report "changed" purely from the
  // scope drift and accept on the first quiet match (settled=1) — exactly the
  // live failure this test pins.
  assert.equal(staleAccepts, 1);
  assert.equal(settled, 0);
});

function pickupSnapshot(y = 500) {
  return makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-pickup',
      label: 'Pickup',
      rect: { x: 20, y, width: 200, height: 44 },
    },
  ]);
}

// Broader-scope variant: adds a non-interactive text node an interactive-only
// capture would never return, modeling the real pre-gesture-baseline vs
// post-gesture-selector-capture scope mismatch.
function pickupSnapshotWithExtraText(y = 500) {
  const base = pickupSnapshot(y);
  return {
    ...base,
    nodes: [
      ...base.nodes,
      {
        ref: 'e3',
        index: 2,
        parentIndex: 0,
        type: 'Text',
        label: 'Delivery choices',
        rect: { x: 20, y: 300, width: 200, height: 20 },
      },
    ],
  };
}

function makeSession(platform: 'ios' | 'android' = 'ios'): SessionState {
  return {
    name: platform,
    device: platform === 'android' ? ANDROID_EMULATOR : IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  };
}
