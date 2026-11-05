import type { CommandFlags } from '@agent-device/contracts/command';
import {
  acquireProviderKeyboard,
  observeCompleteTreeKeyboard,
} from '@agent-device/contracts/tap-keyboard-occlusion';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { buildInteractionSurfaceSignature } from '../interaction-surface-signature.ts';
import {
  capturePostGestureStabilizedResult,
  pendingSurfaceStabilization,
  markDeferredInteractionOutcome,
} from '../deferred-interaction-outcome.ts';
import type { SessionState } from '../session-state.ts';
import {
  chromeWithListSnapshot,
  deliverySnapshot,
  keyboardWindowNodes,
  makeSession,
  pickupSnapshot,
  pickupSnapshotWithExtraText,
} from './post-gesture-stabilization-fixtures.ts';
import {
  appCaptureComparisonKey,
  systemSurfaceCaptureComparisonKey,
} from './ios-comparison-key-fixture.ts';

// Pure verdict/classifier coverage (decidePostGestureStabilityVerdict) lives
// in the sibling post-gesture-stabilization-verdict.test.ts, and the
// agent-facing no-effect claim (corroboration, vetoes, warning wording) in
// post-gesture-no-effect-claim.test.ts — split by subject per #1563 review.

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

  assert.equal(pendingSurfaceStabilization(session)?.action, 'swipe');
});

test('markPostGestureStabilization marks Android swipe sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'swipe');

  assert.equal(pendingSurfaceStabilization(session)?.action, 'swipe');
});

test('markPostGestureStabilization marks gesture swipe sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'gesture', ['swipe', 'left']);

  assert.equal(pendingSurfaceStabilization(session)?.action, 'gesture');
});

test('markPostGestureStabilization honors an explicit opt-out', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'swipe', [], { postGestureStabilization: false });

  assert.equal(pendingSurfaceStabilization(session), undefined);
});

test.for([
  ['scroll', ['down']],
  ['swipe', []],
  ['gesture', ['swipe', 'left']],
] as const)(
  'an opted-out %s on iOS leaves nothing pending, so the next capture is one plain read',
  async ([action, positionals]) => {
    const optedOut = makeSession('ios');
    optedOut.snapshot = pickupSnapshot(500);
    markPostGestureStabilization(optedOut, action, [...positionals], {
      postGestureStabilization: false,
    });
    const asked = makeSession('ios');
    asked.snapshot = pickupSnapshot(500);
    markPostGestureStabilization(asked, action, [...positionals]);

    // The opt-out is the only difference: the same gesture without it owes the loop.
    assert.equal(pendingSurfaceStabilization(asked)?.action, action);
    assert.equal(pendingSurfaceStabilization(optedOut), undefined);

    const capture = vi.fn(async () => pickupSnapshot(500));
    const result = await capturePostGestureStabilizedResult({
      session: optedOut,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });

    assert.equal(capture.mock.calls.length, 1);
    assert.equal(result.postGestureOutcome, undefined);
  },
);

test('markPostGestureStabilization ignores non-swipe gesture sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'gesture', ['pinch', 'in']);

  assert.equal(pendingSurfaceStabilization(session), undefined);
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
    pendingSurfaceStabilization(session)?.baseline?.signature,
    buildInteractionSurfaceSignature(session.snapshot.nodes),
  );
  assert.ok((pendingSurfaceStabilization(session)?.baseline?.signature?.length ?? 0) > 0);
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

  assert.equal(pendingSurfaceStabilization(session)?.baseline?.signature, undefined);
});

test('markPostGestureStabilization tolerates a missing pre-gesture snapshot on iOS', () => {
  const session = makeSession('ios');

  markPostGestureStabilization(session, 'scroll');

  // "No usable baseline" has exactly one representation: the field is absent,
  // so nothing downstream ever has to distinguish `undefined` from `[]` — and
  // the loop cannot rebase a baseline that was never really there.
  assert.equal(pendingSurfaceStabilization(session)?.baseline?.signature, undefined);
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
  assert.equal(pendingSurfaceStabilization(session), undefined);
  // #1600: a stale-accept is the daemon PROVING the gesture moved nothing —
  // that verdict must reach the caller, not only the diagnostics stream.
  assert.equal(result.postGestureOutcome?.kind, 'no-effect');
  assert.equal(result.postGestureOutcome?.gesture.action, 'scroll');
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
  assert.equal(result.postGestureOutcome, undefined);
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
  assert.equal(result.postGestureOutcome, undefined);
  // Accepted at the first quiet match (initial capture + one poll = 2
  // attempts): no distrust cost for a genuine settle.
  assert.equal(capture.mock.calls.length, 2);
});

test('capturePostGestureStabilizedResult trusts an Android baseline match immediately (no distrust cost)', async () => {
  vi.useFakeTimers();
  const session = makeSession('android');
  session.snapshot = pickupSnapshot(500);
  markPostGestureStabilization(session, 'scroll');
  assert.equal(pendingSurfaceStabilization(session)?.baseline?.signature, undefined);

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

test('a deadline that expires right after a rebased quiet pair is not reported as unsettled', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(pickupSnapshot(500).nodes, {
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  markPostGestureStabilization(session, 'scroll');
  // Moving on the baseline backend until the final poll pair, which agrees on another backend:
  // the loop rebases on it and then runs out of time with the surface at rest.
  let call = 0;
  const capture = vi.fn(async () => {
    call += 1;
    return call >= 8
      ? makeSnapshotState(pickupSnapshot(640).nodes, {
          snapshotQuality: { state: 'healthy', backend: 'private-ax' },
        })
      : makeSnapshotState(pickupSnapshot(100 + call * 40).nodes, {
          snapshotQuality: { state: 'healthy', backend: 'tree' },
        });
  });

  const resultPromise = withDiagnosticsScope({}, async () => ({
    result: await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    }),
    rebased: countDiagnosticEventsByPhase(['post_gesture_snapshot_baseline_rebased']),
    timeouts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilization_timeout']),
  }));
  await vi.advanceTimersByTimeAsync(1_700);
  const { result, rebased, timeouts } = await resultPromise;

  assert.deepEqual([rebased, timeouts], [1, 1]);
  assert.equal(result.postGestureOutcome, undefined);
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
    (pendingSurfaceStabilization(session)?.baseline?.signature?.length ?? 0) >
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

test('capturePostGestureStabilizedResult settles at the first quiet pair after a drag that only dismissed the keyboard (iOS)', async () => {
  // The keyboard-dismissing drag moves no content, so every read matches the pre-gesture content.
  // The capture's keyboard fact saying the keyboard left is what proves the read fresh; without it
  // the loop polled to the cap.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = {
    ...makeSnapshotState([...pickupSnapshot(500).nodes, ...keyboardWindowNodes()]),
    keyboard: {
      kind: 'visible',
      frame: { x: 0, y: 400, width: 390, height: 444 },
      treeBound: true,
    },
  };
  markPostGestureStabilization(session, 'swipe');

  const capture = vi.fn(async () => ({
    ...pickupSnapshot(500),
    keyboard: { kind: 'absent' as const, treeBound: true as const },
  }));

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
  assert.equal(result.postGestureOutcome, undefined);
  assert.equal(capture.mock.calls.length, 2);
});

test('capturePostGestureStabilizedResult still distrusts a read that only lost the keyboard nodes, with no keyboard fact (iOS)', async () => {
  // A narrower presentation can leave the keyboard's nodes out while the keyboard is still up, so
  // missing nodes do not prove the read fresh.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = {
    ...makeSnapshotState([...pickupSnapshot(500).nodes, ...keyboardWindowNodes()]),
    keyboard: {
      kind: 'visible',
      frame: { x: 0, y: 400, width: 390, height: 444 },
      treeBound: true,
    },
  };
  markPostGestureStabilization(session, 'swipe');

  const capture = vi.fn(async () => pickupSnapshot(500));

  const resultPromise = withDiagnosticsScope({}, async () => {
    await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      settled: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilized']),
    };
  });

  await vi.advanceTimersByTimeAsync(10_000);
  const { staleAccepts, settled } = await resultPromise;

  assert.equal(staleAccepts, 1);
  assert.equal(settled, 0);
});

test('capturePostGestureStabilizedResult still distrusts a stale WebDriver source whose separate visibility probe changed (iOS)', async () => {
  // Appium reads page source, then probes keyboard visibility on its own. The source here never
  // changes from the pre-gesture tree, while the probe answers up before the gesture and down after.
  vi.useFakeTimers();
  const appiumCapture = (visibility: boolean) => {
    const source = pickupSnapshot(500);
    return {
      ...source,
      keyboard: acquireProviderKeyboard({ nodes: source.nodes, viewport: null, visibility })
        .keyboard,
    };
  };
  const session = makeSession('ios');
  session.snapshot = appiumCapture(true);
  // Both reads carry a visibility probe that disagrees; only the missing binding keeps them apart.
  assert.deepEqual(session.snapshot.keyboard, { kind: 'visibility-only', visible: true });
  assert.deepEqual(appiumCapture(false).keyboard, { kind: 'visibility-only', visible: false });
  markPostGestureStabilization(session, 'swipe');

  const capture = vi.fn(async () => appiumCapture(false));

  const resultPromise = withDiagnosticsScope({}, async () => {
    await capturePostGestureStabilizedResult({
      session,
      capture,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      settled: countDiagnosticEventsByPhase(['post_gesture_snapshot_stabilized']),
    };
  });

  await vi.advanceTimersByTimeAsync(10_000);
  const { staleAccepts, settled } = await resultPromise;

  assert.equal(staleAccepts, 1);
  assert.equal(settled, 0);
});

/** A Simulator AX bridge capture: one complete read of the app's tree, keyboard window included. */
function bridgeCapture(keyboard: boolean) {
  const source = makeSnapshotState([
    ...pickupSnapshot(500).nodes,
    ...(keyboard ? keyboardWindowNodes() : []),
  ]);
  return {
    ...source,
    keyboard: observeCompleteTreeKeyboard({
      nodes: source.nodes,
      viewport: { x: 0, y: 0, width: 390, height: 844 },
      complete: true,
    }),
  };
}

async function stabilizeBridgeCaptures(params: { before: boolean; after: boolean }) {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = bridgeCapture(params.before);
  markPostGestureStabilization(session, 'swipe');
  const baselineKeyboard = session.snapshot.keyboard;
  const capture = vi.fn(async () => bridgeCapture(params.after));

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
  return {
    staleAccepts,
    settled,
    baselineKeyboard,
    quietKeyboard: result.value.keyboard,
    postGestureOutcome: result.postGestureOutcome,
    captures: capture.mock.calls.length,
  };
}

test('capturePostGestureStabilizedResult settles when a complete bridge tree loses the keyboard it derived (iOS)', async () => {
  const outcome = await stabilizeBridgeCaptures({ before: true, after: false });

  assert.deepEqual(outcome.baselineKeyboard, {
    kind: 'derived',
    derivation: 'docked-tree',
    frame: { x: 0, y: 500, width: 390, height: 344 },
    treeBound: true,
  });
  assert.deepEqual(outcome.quietKeyboard, { kind: 'absent', treeBound: true });
  assert.equal(outcome.settled, 1);
  assert.equal(outcome.staleAccepts, 0);
  assert.equal(outcome.postGestureOutcome, undefined);
  assert.equal(outcome.captures, 2);
});

test('capturePostGestureStabilizedResult still distrusts bridge trees whose keyboard fact did not change (iOS)', async () => {
  // The same fact on both sides proves nothing, so the content comparison decides, and it never moved.
  for (const keyboard of [false, true]) {
    const outcome = await stabilizeBridgeCaptures({ before: keyboard, after: keyboard });

    assert.equal(outcome.quietKeyboard?.kind, keyboard ? 'derived' : 'absent');
    assert.deepEqual(outcome.quietKeyboard, outcome.baselineKeyboard);
    assert.equal(outcome.staleAccepts, 1, `keyboard ${keyboard}`);
    assert.equal(outcome.settled, 0, `keyboard ${keyboard}`);
    vi.useRealTimers();
  }
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
  // The rebased baseline was read after the gesture, so matching it is a surface at rest: the next
  // quiet pair settles instead of distrusting its way to the stale-accept cap.
  assert.deepEqual([staleAccepts, settled], [0, 1]);
  assert.equal(capture.mock.calls.length, 3);
});

// --- #2438: a system surface appearing or dismissing mid-poll is not comparable evidence ---

test('capturePostGestureStabilizedResult re-baselines when an in-place system surface appears (iOS)', async () => {
  // A web sign-in sheet is hosted out of the app's process. Its tree and the app's tree describe
  // different surfaces, so a quiet capture of the sheet says nothing about a gesture taken against
  // the app. Both captures are XCTest: what keeps them incomparable is that the route lineages a
  // surface capture to its host, so their comparison keys differ by construction (#2438).
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(pickupSnapshot(500).nodes, {
    snapshotQuality: { state: 'healthy', backend: 'tree' },
    comparisonKey: appCaptureComparisonKey(session.device.id, 'com.example.app'),
  });
  markPostGestureStabilization(session, 'scroll');

  const capture = vi.fn(async () =>
    makeSnapshotState(pickupSnapshot(500).nodes, {
      snapshotQuality: { state: 'healthy', backend: 'tree' },
      comparisonKey: systemSurfaceCaptureComparisonKey(session.device.id),
      iosSystemSurfaceBundleId: 'com.apple.SafariViewService',
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

  assert.equal(rebased, 1);
  // The rebased baseline was read after the gesture, so matching it is a surface at rest: the next
  // quiet pair settles instead of distrusting its way to the stale-accept cap.
  assert.deepEqual([staleAccepts, settled], [0, 1]);
  assert.equal(capture.mock.calls.length, 3);
});

test('capturePostGestureStabilizedResult re-baselines when an in-place system surface dismisses (iOS)', async () => {
  // The mirror case: the baseline was the sheet and the app returns underneath it.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(pickupSnapshot(500).nodes, {
    snapshotQuality: { state: 'healthy', backend: 'tree' },
    comparisonKey: systemSurfaceCaptureComparisonKey(session.device.id),
    iosSystemSurfaceBundleId: 'com.apple.SafariViewService',
  });
  markPostGestureStabilization(session, 'scroll');

  const capture = vi.fn(async () =>
    makeSnapshotState(pickupSnapshot(500).nodes, {
      snapshotQuality: { state: 'healthy', backend: 'tree' },
      comparisonKey: appCaptureComparisonKey(session.device.id, 'com.example.app'),
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

  assert.equal(rebased, 1);
  // The rebased baseline was read after the gesture, so matching it is a surface at rest: the next
  // quiet pair settles instead of distrusting its way to the stale-accept cap.
  assert.deepEqual([staleAccepts, settled], [0, 1]);
  assert.equal(capture.mock.calls.length, 3);
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

// A `wait stable` poll bounds its capture with a deadline abort. The record is consumed by entering
// the loop: left armed, every later capture on the session would pay the whole loop again and the
// wait would keep timing out with zero captures (#2885).
test('capturePostGestureStabilizedResult clears the pending record when a capture aborts mid-loop', async () => {
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = pickupSnapshot(500);
  markPostGestureStabilization(session, 'scroll');
  assert.ok(pendingSurfaceStabilization(session));

  let captureCount = 0;
  const capture = vi.fn(async () => {
    captureCount += 1;
    if (captureCount === 1) return pickupSnapshot(500);
    throw new DOMException('Wait deadline exceeded', 'TimeoutError');
  });

  const resultPromise = capturePostGestureStabilizedResult({
    session,
    capture,
    readSnapshot: (snapshot) => snapshot,
  }).then(
    () => 'resolved' as const,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  const outcome = await resultPromise;

  assert.ok(outcome instanceof DOMException && outcome.name === 'TimeoutError');
  assert.equal(captureCount, 2);
  assert.equal(pendingSurfaceStabilization(session), undefined);
});
