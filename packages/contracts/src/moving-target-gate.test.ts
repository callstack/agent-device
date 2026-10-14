import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  MOVING_TARGET_GATE_SAMPLE_GAP_MS,
  MOVING_TARGET_GATE_WINDOW_MS,
  movingTargetGateDecision,
} from './moving-target-gate.ts';

// #3471: the two judgements the moving-target gate makes, isolated from both callers so the window
// and the stability rule have exactly one reading. Whether two captures count as one position is
// kernel's `areCapturedRectsAtSamePosition`, tested beside the band it owns
// (`packages/kernel/src/rect-center.test.ts`). The runtime half (what a press does with these
// answers) is `src/commands/interaction/runtime/moving-target-gate.ts`; the Layer-3 scenarios behind
// the ADR 0011 `targetStability` cells drive the whole press.

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

// The refusal's published recovery is asserted in the runtime gate's suite, where the hint lives
// beside the refusal that publishes it (`movingTargetHint`); this module decides, it does not speak.
