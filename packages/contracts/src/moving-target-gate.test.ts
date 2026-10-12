import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  MOVING_TARGET_GATE_RECT_TOLERANCE_PX,
  MOVING_TARGET_GATE_SAMPLE_GAP_MS,
  MOVING_TARGET_GATE_WINDOW_MS,
  movingTargetGateDecision,
  movingTargetRectsStable,
  targetStillMovingHint,
} from './moving-target-gate.ts';

// #3471: the two judgements the moving-target gate makes, isolated from both callers so the window
// and the stability rule have exactly one reading. The runtime half (what a press does with these
// answers) is `src/commands/interaction/runtime/moving-target-gate.ts`; the Layer-3 scenarios behind
// the ADR 0011 `targetStability` cells drive the whole press.

const RECT = { x: 100, y: 200, width: 120, height: 44 };

function shifted(over: Partial<typeof RECT> = {}) {
  return { ...RECT, ...over };
}

// --- is a second observation owed? ---

test('a session with no mutation clock is idle and owes nothing', () => {
  // `targetShownAtRest` is deliberately the disturbing kind here: with no clock there is nothing to
  // wait out, and an absent clock must not read as "a mutation just finished".
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: undefined,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'idle' });
});

test('a target the previous action left in place is answered without a re-observation', () => {
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 9_900,
    targetShownAtRest: true,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'stationary' });
});

test('the window is measured from the mutation END, so only what is LEFT of it is waited out', () => {
  // The action finished 400 ms ago; a full window of waiting would be a 900 ms pause on a press
  // whose surface has already been quiet for 400 ms.
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 9_600,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'recheck', waitMs: 100 });
});

test('the declared window is the 500 ms transition budget, and its edge decides the branch', () => {
  // The edge is exclusive: at exactly the budget the resolved point already stands, because an
  // action that finished a full window ago has no claim on this press.
  assert.equal(MOVING_TARGET_GATE_WINDOW_MS, 500);
  const atEdge = movingTargetGateDecision({
    baselineFinishedAtMs: 10_000 - MOVING_TARGET_GATE_WINDOW_MS,
    targetShownAtRest: false,
    nowMs: 10_000,
  });
  const inside = movingTargetGateDecision({
    baselineFinishedAtMs: 9_600,
    targetShownAtRest: false,
    nowMs: 10_000,
  });
  const outside = movingTargetGateDecision({
    baselineFinishedAtMs: 9_400,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(atEdge, { kind: 'not-recent' });
  assert.equal(inside.kind, 'recheck');
  assert.equal(outside.kind, 'not-recent');
});

test('inside the window, only a tree that shows the target at rest excuses the re-observation', () => {
  // One bit carries the whole screening verdict, because that is all this branch can use: absent,
  // ambiguous, and moved all mean the same thing here — the session cannot show where the target
  // came to rest, so it owes the look.
  for (const targetShownAtRest of [false, true] as const) {
    const decision = movingTargetGateDecision({
      baselineFinishedAtMs: 9_950,
      targetShownAtRest,
      nowMs: 10_000,
    });

    assert.equal(
      decision.kind,
      targetShownAtRest ? 'stationary' : 'recheck',
      `targetShownAtRest ${String(targetShownAtRest)}`,
    );
  }
});

test('the wait never drops below one sample gap, even as the window closes', () => {
  // Re-observing immediately would compare two captures the same animation frame could produce,
  // and agreement would then be a timing accident rather than the target having stopped.
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 9_520,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'recheck', waitMs: MOVING_TARGET_GATE_SAMPLE_GAP_MS });
});

test('a clock skew ahead of the mutation does not produce a negative wait', () => {
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 10_100,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.ok(decision.kind === 'recheck');
  assert.ok(decision.waitMs >= MOVING_TARGET_GATE_SAMPLE_GAP_MS);
});

// --- has the target stopped? ---

test('two observations at the same rect are a resting position', () => {
  assert.equal(movingTargetRectsStable(RECT, shifted()), true);
});

test('capture rounding within the declared tolerance is not motion', () => {
  assert.equal(MOVING_TARGET_GATE_RECT_TOLERANCE_PX, 1);
  assert.equal(movingTargetRectsStable(RECT, shifted({ x: RECT.x + 1 })), true);
  assert.equal(movingTargetRectsStable(RECT, shifted({ height: RECT.height + 1 })), true);
});

test('one axis moving is enough to still be moving', () => {
  // The slide-in case from the #3471 repro (ADB Android): a translate animation keeps width and
  // height constant, so only one axis says the target moved.
  assert.equal(movingTargetRectsStable(RECT, shifted({ x: RECT.x + 2 })), false);
  assert.equal(movingTargetRectsStable(RECT, shifted({ y: RECT.y + 2 })), false);
  assert.equal(movingTargetRectsStable(RECT, shifted({ width: RECT.width + 2 })), false);
  assert.equal(movingTargetRectsStable(RECT, shifted({ height: RECT.height + 2 })), false);
});

test('an observation that could not measure the target never agrees with one that could', () => {
  // Absence is the surface having changed under the point, which is the exposure the gate exists
  // to catch — so it can never be the observation that certifies rest.
  assert.equal(movingTargetRectsStable(RECT, undefined), false);
  assert.equal(movingTargetRectsStable(undefined, RECT), false);
  assert.equal(movingTargetRectsStable(undefined, undefined), false);
  assert.equal(movingTargetRectsStable(RECT, shifted({ width: Number.NaN })), false);
});

test('the stability comparison is symmetric', () => {
  assert.equal(
    movingTargetRectsStable(shifted({ y: 205 }), RECT),
    movingTargetRectsStable(RECT, shifted({ y: 205 })),
  );
});

// --- the refusal's published recovery ---

test('a refused selector press names the wait that recovers it', () => {
  const hint = targetStillMovingHint({ selector: 'label="Slide target"' });

  assert.match(hint, /wait 'label="Slide target"'/);
  assert.match(hint, /same selector/);
  assert.match(hint, /--settle/);
  assert.match(hint, /nothing was tapped/);
});

test('a refused @ref press is sent to a selector, because the wait would retire its frame', () => {
  // ADR 0014: the capture a `wait` takes expires the ref frame, so telling the caller to retry the
  // same ref would trade a motion refusal for a stale-ref refusal.
  const hint = targetStillMovingHint({ selector: undefined });

  assert.match(hint, /snapshot -i/);
  assert.match(hint, /selector/);
  assert.match(hint, /ref frame/);
  assert.doesNotMatch(hint, /wait '/);
});
