import type { CommandFlags } from '@agent-device/contracts/command';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { makeSnapshotState } from '../../__tests__/test-utils/index.ts';
import { countDiagnosticEventsByPhase, withDiagnosticsScope } from '../../utils/diagnostics.ts';
import { buildInteractionSurfaceSignature } from '../interaction-outcome-policy.ts';
import {
  capturePostGestureStabilizedResult,
  markDeferredInteractionOutcome,
} from '../deferred-interaction-outcome.ts';
import { formatGestureNoEffectWarning } from '../gesture-no-effect.ts';
import type { SessionState } from '../types.ts';
import {
  chromeWithListSnapshot,
  deliverySnapshot,
  keyboardWindowNodes,
  makeSession,
  pickupSnapshot,
  pickupSnapshotWithExtraText,
} from './post-gesture-stabilization-fixtures.ts';

// Pure verdict/classifier coverage (decidePostGestureStabilityVerdict) lives
// in the sibling post-gesture-stabilization-verdict.test.ts — split per
// #1563 review to stay under the repo's 500-line test-file tripwire.

afterEach(() => {
  vi.useRealTimers();
});

// Stabilization marking is module-private behind the deferred-interaction-outcome
// interface; this shim keeps each marking test phrased in stabilization terms
// while driving the same public entry every shipping caller uses.
function markPostGestureStabilization(
  session: SessionState,
  action: string,
  positionals: string[] = [],
  flags?: CommandFlags,
): void {
  markDeferredInteractionOutcome({ session, command: action, positionals, flags });
}

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

// ---------------------------------------------------------------------------
// capturePostGestureStabilizedResult: the async loop wired to the pure
// decision in post-gesture-stabilization-verdict.test.ts. Fake timers keep
// these instant despite the real 200ms poll interval and (for the distrust
// path) the 3.5s cap.
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
  const { result, staleAccepts, settled } = await resultPromise;

  assert.equal(staleAccepts, 1);
  assert.equal(settled, 0);
  assert.equal(session.postGestureStabilization, undefined);
  // #1600: a stale-accept is the daemon PROVING the gesture moved nothing —
  // that verdict must reach the caller, not only the diagnostics stream.
  assert.equal(result.gestureNoEffect?.action, 'scroll');
  // Proves it kept polling well past the OLD 1.5s accept point (2 attempts,
  // ~200ms) instead of trusting the first quiet match.
  assert.ok(captureCount > 8, `expected sustained polling, saw ${captureCount} captures`);
});

test('a replaced list under fixed chrome now settles outright, and still claims no no-effect (#1601 P1, #1569)', async () => {
  // The reviewer's counterexample: a SUCCESSFUL scroll swapped every list cell
  // while the tab-bar chrome (discriminating, shared, unmoved) kept the
  // classifier at 'unchanged'. #1601 could only veto the agent-facing claim and
  // had to let the loop accept the stale read — `staleAccepts` was 1 here.
  //
  // #1569 removed the premise: the classifier compares identified content by
  // set membership, so cells leaving AND arriving is 'changed'. The loop now
  // trusts the capture instead of polling to the cap, which is what made every
  // checkout-form scroll pay the full distrust budget on live hardware. The
  // no-effect claim stays absent — now because there is no accept-stale to
  // corroborate at all, which is the stronger reason.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = chromeWithListSnapshot(['row-1', 'row-2']);
  markPostGestureStabilization(session, 'scroll');

  const capture = vi.fn(async () => chromeWithListSnapshot(['row-3', 'row-4']));

  const resultPromise = withDiagnosticsScope({}, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
    };
  });

  await vi.advanceTimersByTimeAsync(10_000);
  const { result, staleAccepts } = await resultPromise;

  assert.equal(staleAccepts, 0);
  assert.equal(result.gestureNoEffect, undefined);
});

test('scope drift accepts stale but is vetoed from claiming no-effect (#1601 P1 gate)', async () => {
  // #1601's full-surface gate stays load-bearing, and #1569 makes it more so.
  // The classifier treats a one-sided difference as scope drift rather than
  // movement, so a narrower quiet capture of an unmoved screen still reaches
  // accept-stale — and the agent-facing claim must not follow it there, because
  // the missing rows are unexamined, not proven absent.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = chromeWithListSnapshot(['row-1', 'row-2']);
  markPostGestureStabilization(session, 'scroll');

  // Same screen, but the quiet captures see only the chrome — the shape a
  // broad baseline followed by an interactive-only capture produces.
  const narrowed = makeSnapshotState(
    chromeWithListSnapshot(['row-1', 'row-2']).nodes.filter(
      (node) => node.type !== 'Cell',
    ) as never,
  );
  const capture = vi.fn(async () => narrowed);

  const resultPromise = withDiagnosticsScope({}, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
    };
  });

  await vi.advanceTimersByTimeAsync(10_000);
  const { result, staleAccepts } = await resultPromise;

  assert.equal(staleAccepts, 1);
  assert.equal(result.gestureNoEffect, undefined);
});

test('formatGestureNoEffectWarning names the gesture and the raw-drag escape hatch', () => {
  const scrollWarning = formatGestureNoEffectWarning('scroll', ['down', '1']);
  assert.match(scrollWarning, /scroll down produced no visible change/);
  assert.match(scrollWarning, /swipe x1 y1 x2 y2/);
  assert.match(scrollWarning, /already at its edge/);

  const gestureWarning = formatGestureNoEffectWarning('gesture', ['swipe', 'left']);
  assert.match(gestureWarning, /gesture swipe left produced no visible change/);

  const bareWarning = formatGestureNoEffectWarning('swipe', []);
  assert.match(bareWarning, /swipe produced no visible change/);
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
  const { result, staleAccepts, settled } = await resultPromise;

  assert.equal(settled, 1);
  assert.equal(staleAccepts, 0);
  // A genuine settle carries no no-effect claim.
  assert.equal(result.gestureNoEffect, undefined);
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

// --- #1563 review, finding 1: a root-only shared overlap must trust immediately, not tax the cap ---

test('capturePostGestureStabilizedResult trusts immediately (no cap tax) when a real scroll leaves only the application root shared — #1563 review regression', async () => {
  // The reviewer's exact false-distrust shape end to end: the baseline is
  // Application + Pickup; every post-gesture read is Application + a
  // DIFFERENT button (Delivery) — a genuine, successful scroll that swapped
  // every real element. A boolean "any shared entry frozen" predicate would
  // call the shared, always-identical Application root a baseline match and
  // extend this to the 3.5s stale-read cap on zero real evidence.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot(500);
  markPostGestureStabilization(session, 'scroll');

  const capture = vi.fn(async () => deliverySnapshot(120)); // consistent from the first read: quiet immediately

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
  // Trusted at the first quiet match (initial capture + one poll = 2
  // attempts): root-only overlap is ambiguous, not a baseline match, so it
  // never pays the 3.5s distrust cap.
  assert.equal(capture.mock.calls.length, 2);
});

// --- #1563 review, finding 2: keyboard DESCENDANTS (not just the container) must not read as evidence ---

test('capturePostGestureStabilizedResult trusts immediately (no cap tax) when the overlap is only keyboard descendants, not the container', async () => {
  // Same end-to-end shape as the root-only regression above, but the shared
  // non-evidence is a keyboard's descendants (a key, the "Next keyboard"
  // assistant button — siblings of the [Keyboard] container, not inside it)
  // instead of the viewport root. A container-only exclusion still counts
  // these as real, frozen evidence and extends to the 3.5s cap.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState([...pickupSnapshot(500).nodes, ...keyboardWindowNodes()]);
  markPostGestureStabilization(session, 'scroll');

  const capture = vi.fn(async () =>
    makeSnapshotState([...deliverySnapshot(120).nodes, ...keyboardWindowNodes()]),
  );

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
  assert.equal(capture.mock.calls.length, 2);
});

// --- #1569: a backend swap mid-poll is not comparable evidence ---

test('capturePostGestureStabilizedResult re-baselines instead of concluding when the backend changes (iOS)', async () => {
  // The capture plan can fall back, or the XCTest-channel penalty can pre-empt
  // it, at any point during the poll. The backends do not agree on which nodes
  // exist — on one live checkout screen private AX returned 139 nodes including
  // 43 scrolled off-viewport where the tree backend returned 48 — so a quiet
  // capture from a different backend says nothing about the gesture. It must
  // become the new baseline, never a verdict.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(pickupSnapshot(500).nodes, {
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  markPostGestureStabilization(session, 'scroll');

  // Every capture shows the pre-gesture surface, but on the OTHER backend.
  const capture = vi.fn(async () =>
    makeSnapshotState(pickupSnapshot(500).nodes, {
      snapshotQuality: { state: 'healthy', backend: 'private-ax' },
    }),
  );

  const resultPromise = withDiagnosticsScope({}, async () => {
    await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      rebased: countDiagnosticEventsByPhase(['post_gesture_snapshot_baseline_rebased']),
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      settled: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilized']),
    };
  });

  await vi.advanceTimersByTimeAsync(6_000);
  const { rebased, staleAccepts, settled } = await resultPromise;

  // Rebased once onto private-ax, then compared same-backend and settled. A
  // cross-backend comparison would have produced a verdict from incomparable
  // node sets instead.
  assert.equal(rebased, 1);
  assert.equal(staleAccepts + settled, 1);
});

test('capturePostGestureStabilizedResult still distrusts a same-backend baseline match (iOS)', async () => {
  // The guard above must not become a blanket escape hatch: when the backend is
  // stable, an unchanged surface is still the stale-read signal #1542 added.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(pickupSnapshot(500).nodes, {
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  markPostGestureStabilization(session, 'scroll');

  const capture = vi.fn(async () =>
    makeSnapshotState(pickupSnapshot(500).nodes, {
      snapshotQuality: { state: 'healthy', backend: 'tree' },
    }),
  );

  const resultPromise = withDiagnosticsScope({}, async () => {
    await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      rebased: countDiagnosticEventsByPhase(['post_gesture_snapshot_baseline_rebased']),
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
    };
  });

  await vi.advanceTimersByTimeAsync(6_000);
  const { rebased, staleAccepts } = await resultPromise;

  assert.equal(rebased, 0);
  assert.equal(staleAccepts, 1);
});
