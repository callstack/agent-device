import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { countDiagnosticEventsByPhase, withDiagnosticsScope } from '../../utils/diagnostics.ts';
import {
  buildInteractionSurfaceSignature,
  summarizeDiscriminatingSurfaceDivergence,
} from '../interaction-outcome-policy.ts';
import type { CommandFlags } from '@agent-device/contracts/command';
import {
  capturePostGestureStabilizedResult,
  markDeferredInteractionOutcome,
} from '../deferred-interaction-outcome.ts';
import { formatGestureNoEffectWarning } from '../gesture-no-effect.ts';
import type { SessionState } from '../types.ts';
import {
  chromeWithListSnapshot,
  makeSession,
  pickupSnapshot,
} from './post-gesture-stabilization-fixtures.ts';

// When the agent-facing gestureNoEffect claim may and may not surface — split
// by subject from post-gesture-stabilization.test.ts (the capture loop), the
// same #1563 convention that keeps test files under the repo's 500-line
// tripwire. Loop mechanics (rebase, distrust budget, timeouts) stay in the
// loop file; everything here is about the claim and its veto instrumentation.

afterEach(() => {
  vi.useRealTimers();
});

// Marking is module-private behind the deferred-interaction-outcome interface;
// this shim drives the same public entry every shipping caller uses.
function markPostGestureStabilization(
  session: SessionState,
  action: string,
  positionals: string[] = [],
  flags?: CommandFlags,
): void {
  markDeferredInteractionOutcome({ session, command: action, positionals, flags });
}

/**
 * Runs the loop under a diagnostics scope that also writes its NDJSON trace to
 * a file, and returns the veto events parsed back out of it.
 *
 * The counts alone are not the behavior under test: what an operator reads on
 * a `--debug` run is the emitted `reason` and divergence numbers, and a
 * regression that emits the wrong reason — or drops the counts entirely —
 * keeps every count at 1. Reading the serialized line (rather than an
 * in-memory event array) pins what actually reaches the log, redaction
 * included.
 */
async function runStabilization(
  session: ReturnType<typeof makeSession>,
  capture: () => ReturnType<typeof makeSnapshotState>,
) {
  const captureFn = vi.fn(async () => capture());
  const traceLogPath = path.join(mkdtempForTestSync('agent-device-veto-trace-'), 'trace.ndjson');
  const resultPromise = withDiagnosticsScope({ traceLogPath }, async () => {
    const result = await capturePostGestureStabilizedResult({
      session,
      capture: captureFn,
      readSnapshot: (snapshot) => snapshot,
    });
    return {
      result,
      staleAccepts: countDiagnosticEventsByPhase(['post_gesture_snapshot_stale_accept']),
      rebased: countDiagnosticEventsByPhase(['post_gesture_snapshot_baseline_rebased']),
      vetoed: countDiagnosticEventsByPhase(['post_gesture_no_effect_vetoed']),
    };
  });
  await vi.advanceTimersByTimeAsync(10_000);
  const outcome = await resultPromise;
  return { ...outcome, vetoEvents: readVetoEvents(traceLogPath) };
}

/** The `post_gesture_no_effect_vetoed` payloads written to a diagnostics trace. */
function readVetoEvents(traceLogPath: string): Record<string, unknown>[] {
  if (!fs.existsSync(traceLogPath)) return [];
  return fs
    .readFileSync(traceLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> })
    .filter((event) => event.phase === 'post_gesture_no_effect_vetoed')
    .map((event) => event.data ?? {});
}

test('a backend flip mid-poll withholds the no-effect claim, and records the reason (#1620)', async () => {
  // Corroboration reads the ORIGINAL pre-gesture baseline, so a rebase leaves
  // the pair cross-backend and set equality cannot hold — the claim is
  // withheld, which is correct and long-standing. What is new is that the
  // veto says so: silence alone is indistinguishable from a gesture that
  // worked, and that ambiguity is what left #1620 unresolvable for weeks.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(pickupSnapshot(500).nodes, {
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  markPostGestureStabilization(session, 'scroll', ['up']);

  // Post-gesture captures from private-ax, identical to EACH OTHER — a shape
  // equally consistent with an inert gesture and with a fast successful one
  // that settled before the first poll. That ambiguity is the whole point.
  const privateAxNodes = [
    ...pickupSnapshot(500).nodes,
    {
      index: 2,
      parentIndex: 0,
      type: 'StaticText',
      identifier: 'scrolled-away-row',
      label: 'Above the fold',
      rect: { x: 20, y: -80, width: 200, height: 44 },
    },
  ];
  const { result, staleAccepts, rebased, vetoed, vetoEvents } = await runStabilization(
    session,
    () =>
      makeSnapshotState(privateAxNodes, {
        snapshotQuality: { state: 'recovered', backend: 'private-ax' },
      }),
  );

  assert.equal(rebased, 1);
  assert.equal(staleAccepts, 1, 'the loop still accepts the stale read after the distrust budget');
  assert.equal(result.gestureNoEffect, undefined);
  assert.equal(vetoed, 1, 'the withheld claim must be observable');
  // The reason is the point: a rebase means the corroboration pair is
  // cross-backend, which is a categorically different answer from "the
  // surfaces moved" and must not be reported as one. No divergence counts
  // ride along, because there is no comparable pair to count over.
  assert.deepEqual(vetoEvents, [
    {
      action: 'scroll',
      backend: 'private-ax',
      reason: 'baseline_rebased',
    },
  ]);
});

test('a successful scroll that flips the capture backend must not claim no-effect', async () => {
  // Every list cell swapped under fixed chrome — the fixture whose own comment
  // says it "must never surface as an agent-facing no-effect claim" — while
  // the capture backend flipped. Pinned because a rejected #1622 draft made
  // corroboration read the REBASED baseline, which compares the settled screen
  // with itself and fired the claim on this exact input.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(chromeWithListSnapshot(['row-1', 'row-2']).nodes, {
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  markPostGestureStabilization(session, 'scroll', ['down']);

  const { result, rebased, vetoed, vetoEvents } = await runStabilization(session, () =>
    makeSnapshotState(chromeWithListSnapshot(['row-3', 'row-4']).nodes, {
      snapshotQuality: { state: 'recovered', backend: 'private-ax' },
    }),
  );

  assert.equal(rebased, 1);
  assert.equal(
    result.gestureNoEffect,
    undefined,
    'the scroll swapped every list cell — a no-effect claim here is a false positive',
  );
  assert.equal(vetoed, 1);
  // Rebase wins the reason even though the surfaces also genuinely diverged:
  // once the pair is cross-backend the divergence counts would describe two
  // incomparable captures, and reporting them as movement is the exact
  // misreading #1620 spent weeks on.
  assert.deepEqual(vetoEvents, [
    {
      action: 'scroll',
      backend: 'private-ax',
      reason: 'baseline_rebased',
    },
  ]);
});

test('no pre-gesture snapshot means no baseline, no rebase, and no no-effect claim', async () => {
  // Marking stores NO baseline when the session has no pre-gesture snapshot
  // ("no usable baseline" has exactly one representation), so the loop has
  // nothing to rebase and nothing to judge against: the quiet capture is
  // trusted outright and no claim is invented. Previously an empty `[]` was
  // stored, and being truthy it was rebased onto a post-gesture capture.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = undefined; // nothing captured before the gesture
  markPostGestureStabilization(session, 'scroll', ['up']);
  assert.equal(session.postGestureStabilization?.baselineSignature, undefined);

  const { result, rebased, vetoed } = await runStabilization(session, () =>
    makeSnapshotState(pickupSnapshot(500).nodes, {
      snapshotQuality: { state: 'recovered', backend: 'private-ax' },
    }),
  );

  assert.equal(rebased, 0);
  assert.equal(vetoed, 0);
  assert.equal(
    result.gestureNoEffect,
    undefined,
    'a no-effect claim needs a real pre-gesture baseline, never one the loop invented for itself',
  );
});

test('scope drift accepts stale but is vetoed from claiming no-effect, observably (#1601 P1 gate)', async () => {
  // #1601's full-surface gate stays load-bearing: the classifier treats a
  // one-sided difference as scope drift rather than movement, so a narrower
  // quiet capture of an unmoved screen still reaches accept-stale — and the
  // agent-facing claim must not follow it there, because the missing rows are
  // unexamined, not proven absent. The veto now leaves a diagnostic trail.
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
  const { result, staleAccepts, vetoed, vetoEvents } = await runStabilization(
    session,
    () => narrowed,
  );

  assert.equal(staleAccepts, 1);
  assert.equal(result.gestureNoEffect, undefined);
  assert.equal(vetoed, 1);
  // Scope drift reads as one-sided membership, never as movement: both cells
  // are missing from the narrowed capture, the shared chrome button has not
  // moved. An operator seeing rectMismatched: 0 alongside onlyInBaseline: 2
  // can tell "unexamined" from "moved" without re-deriving it.
  // No `backend` key at all: this capture carries no snapshotQuality, and the
  // serialized line omits the field rather than writing a null an aggregator
  // would have to special-case.
  assert.deepEqual(vetoEvents, [
    {
      action: 'scroll',
      reason: 'surface_divergence',
      onlyInBaseline: 2,
      onlyInCurrent: 0,
      rectMismatched: 0,
      shared: 1,
    },
  ]);
});

test('same-backend membership drift vetoes the claim and records the divergence (#1620 truncation drift)', async () => {
  // #1620's second candidate veto: on hostile screens both sides of the pair
  // come from private-ax, but a depth-capped capture might not return the same
  // node set — here the quiet captures carry one deep row the baseline missed.
  // All shared entries are unmoved, so the subset-tolerant classifier reads
  // 'unchanged' and the loop reaches accept-stale; set equality then fails on
  // the extra row. Measured live on the seeded Bluesky fixture this does NOT
  // happen — membership was stable at onlyIn*=0 under the remembered depth-56
  // cap — but the shape is cheap to pin and the veto now names it.
  vi.useFakeTimers();
  const session = makeSession('ios');
  session.snapshot = makeSnapshotState(chromeWithListSnapshot(['row-1', 'row-2']).nodes, {
    snapshotQuality: { state: 'recovered', backend: 'private-ax' },
  });
  markPostGestureStabilization(session, 'scroll', ['down']);

  const driftedNodes = [
    ...chromeWithListSnapshot(['row-1', 'row-2']).nodes,
    {
      index: 9,
      parentIndex: 0,
      type: 'StaticText',
      identifier: 'depth-56-row',
      label: 'Sometimes captured',
      rect: { x: 0, y: 220, width: 390, height: 60 },
    },
  ];
  const { result, staleAccepts, rebased, vetoed, vetoEvents } = await runStabilization(
    session,
    () =>
      makeSnapshotState(driftedNodes, {
        snapshotQuality: { state: 'recovered', backend: 'private-ax' },
      }),
  );

  assert.equal(rebased, 0, 'same backend throughout: this is drift, not a flip');
  assert.equal(staleAccepts, 1);
  assert.equal(result.gestureNoEffect, undefined);
  assert.equal(vetoed, 1);
  // The counts are what distinguish this from the scope-drift case above:
  // one extra key on the CURRENT side, everything shared unmoved. Same veto,
  // opposite direction of membership drift — indistinguishable from an event
  // tally alone.
  assert.deepEqual(vetoEvents, [
    {
      action: 'scroll',
      backend: 'private-ax',
      reason: 'surface_divergence',
      onlyInBaseline: 0,
      onlyInCurrent: 1,
      rectMismatched: 0,
      shared: 3,
    },
  ]);
});

test('summarizeDiscriminatingSurfaceDivergence counts one-sided keys and moved rects, excluding non-discriminating entries', () => {
  const baseline = buildInteractionSurfaceSignature(
    chromeWithListSnapshot(['row-1', 'row-2']).nodes,
  );
  const extraRow = {
    ref: 'e-drift',
    index: 9,
    parentIndex: 0,
    type: 'StaticText',
    identifier: 'depth-56-row',
    label: 'Sometimes captured',
    rect: { x: 0, y: 220, width: 390, height: 60 },
  };
  const drifted = buildInteractionSurfaceSignature([
    ...chromeWithListSnapshot(['row-1', 'row-2']).nodes,
    extraRow,
  ]);

  // chromeWithListSnapshot: Application root (non-discriminating, excluded) +
  // tab button + two cells = 3 discriminating entries shared; the deep row is
  // current-only.
  assert.deepEqual(summarizeDiscriminatingSurfaceDivergence(baseline, drifted), {
    onlyInBaseline: 0,
    onlyInCurrent: 1,
    rectMismatched: 0,
    shared: 3,
  });
  assert.deepEqual(summarizeDiscriminatingSurfaceDivergence(drifted, baseline), {
    onlyInBaseline: 1,
    onlyInCurrent: 0,
    rectMismatched: 0,
    shared: 3,
  });

  const movedNodes = chromeWithListSnapshot(['row-1', 'row-2']).nodes.map((node) =>
    node.identifier === 'row-1' && node.rect
      ? { ...node, rect: { ...node.rect, y: node.rect.y + 40 } }
      : node,
  );
  const moved = buildInteractionSurfaceSignature(movedNodes);
  assert.deepEqual(summarizeDiscriminatingSurfaceDivergence(baseline, moved), {
    onlyInBaseline: 0,
    onlyInCurrent: 0,
    rectMismatched: 1,
    shared: 3,
  });
});

test('formatGestureNoEffectWarning names the gesture and the raw-drag escape hatch', () => {
  // Positionals echo verbatim: the warning names the gesture the agent issued,
  // and `scroll down 1` is what they issued.
  const scrollWarning = formatGestureNoEffectWarning('scroll', ['down', '1']);
  assert.match(scrollWarning, /scroll down 1 produced no visible change/);
  assert.match(scrollWarning, /swipe x1 y1 x2 y2/);
  assert.match(scrollWarning, /already at its edge/);

  const gestureWarning = formatGestureNoEffectWarning('gesture', ['swipe', 'left']);
  assert.match(gestureWarning, /gesture swipe left produced no visible change/);

  const bareWarning = formatGestureNoEffectWarning('swipe', []);
  assert.match(bareWarning, /swipe produced no visible change/);

  // The regression the deleted heuristic caused: every positional of a swipe is
  // a coordinate, so "drop anything numeric-looking" left a contentless "swipe".
  const swipeWarning = formatGestureNoEffectWarning('swipe', ['10', '20', '30', '40']);
  assert.match(swipeWarning, /^swipe 10 20 30 40 produced no visible change/);
});
