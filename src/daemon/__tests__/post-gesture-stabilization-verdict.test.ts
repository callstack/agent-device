import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
  type InteractionSurfaceSignature,
} from '../interaction-outcome-policy.ts';
import { decidePostGestureStabilityVerdict as decideWithHooks } from '../post-gesture-stability.ts';
import {
  applicationRootNode,
  keyboardWindowNodes,
  pickupSnapshot,
} from './post-gesture-stabilization-fixtures.ts';

// The pure verdict takes its baseline comparator as a hook; every case below
// wires the real classifier, so this file keeps testing the same
// classify-then-decide composition shipping callers run.
const decidePostGestureStabilityVerdict = (params: {
  needsBaselineDistrust: boolean;
  baselineSignature: InteractionSurfaceSignature | undefined;
  quietSignature: InteractionSurfaceSignature;
  elapsedMs: number;
  distrustCapMs: number;
}) => decideWithHooks({ ...params, classifyBaselineEvidence: classifyBaselineSurfaceEvidence });

// ---------------------------------------------------------------------------
// #1542 defect 2: baseline-comparison distrust.
//
// After an AX-free synthesized gesture, XCTest's AX tree isn't proactively
// resynced by the synthesized touch, so it can serve a stale-but-internally-
// consistent read: two consecutive polls agree with each other while still
// exactly matching the PRE-gesture tree. `decidePostGestureStabilityVerdict`
// is the pure decision that catches this; the tests below are its exhaustive
// truth table.
//
// Split out of post-gesture-stabilization.test.ts per #1563 review (the pure
// verdict coverage, alongside its own shared fixtures, moved to this sibling
// module so the async-loop test file stays under the repo's 500-line
// tripwire — see post-gesture-stabilization-fixtures.ts).
// ---------------------------------------------------------------------------

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

// --- #1563 review, finding 1: a root-only shared overlap must trust immediately, not tax the cap ---

test('decidePostGestureStabilityVerdict trusts immediately when a real scroll leaves only the application root shared (no cap tax)', () => {
  const baseline = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-pickup',
      label: 'Pickup',
      rect: { x: 20, y: 500, width: 200, height: 44 },
    },
  ]);
  const quiet = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-delivery',
      label: 'Delivery',
      rect: { x: 20, y: 120, width: 200, height: 44 },
    },
  ]);

  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: baseline,
      quietSignature: quiet,
      elapsedMs: 0, // first quiet match, well before any cap
      distrustCapMs: 3_500,
    }),
    'trust',
  );
});

// --- #1563 review, finding 2: keyboard DESCENDANTS (not just the container) must not read as evidence ---

test('decidePostGestureStabilityVerdict trusts immediately when the overlap is only keyboard descendants, not the container', () => {
  // Same keyboard subtree in both baseline and quiet (unmoved — a keyboard
  // does not move when app content scrolls), but the real content behind it
  // changed (Pickup -> Delivery). The shared overlap is Application + the
  // keyboard window + the keyboard container + a key + the "Next keyboard"
  // assistant button — none of which is real, discriminating evidence.
  const baseline = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-pickup',
      label: 'Pickup',
      rect: { x: 20, y: 500, width: 200, height: 44 },
    },
    ...keyboardWindowNodes(),
  ]);
  const quiet = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-delivery',
      label: 'Delivery',
      rect: { x: 20, y: 120, width: 200, height: 44 },
    },
    ...keyboardWindowNodes(), // identical: the keyboard itself never moves
  ]);

  assert.equal(
    decidePostGestureStabilityVerdict({
      needsBaselineDistrust: true,
      baselineSignature: baseline,
      quietSignature: quiet,
      elapsedMs: 0, // first quiet match, well before any cap
      distrustCapMs: 3_500,
    }),
    'trust',
  );
});
