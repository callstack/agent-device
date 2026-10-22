import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
  type InteractionSurfaceSignature,
} from '../interaction-surface-signature.ts';
import {
  decidePostGestureStabilityVerdict as decideWithHooks,
  type PostGestureBaseline,
  type PostGesturePreActionBaseline,
} from '@agent-device/capture-kit/post-gesture-stability';
import {
  applicationRootNode,
  keyboardWindowNodes,
  pickupSnapshot,
} from './post-gesture-stabilization-fixtures.ts';

// The pure verdict takes its baseline comparator as a hook; every case below
// wires the real classifier, so this file keeps testing the same
// classify-then-decide composition shipping callers run.
const decidePostGestureStabilityVerdict = (params: {
  baseline: PostGestureBaseline<InteractionSurfaceSignature> | undefined;
  quietSignature: InteractionSurfaceSignature;
  elapsedMs: number;
  distrustCapMs: number;
}) => decideWithHooks({ ...params, classifyBaselineEvidence: classifyBaselineSurfaceEvidence });

function preActionBaseline(
  signature: InteractionSurfaceSignature,
): PostGesturePreActionBaseline<InteractionSurfaceSignature> {
  return { provenance: 'pre-action', signature, comparisonKey: 'runner|app' };
}

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
// module — see post-gesture-stabilization-fixtures.ts).
// ---------------------------------------------------------------------------

test('decidePostGestureStabilityVerdict trusts immediately when no baseline was authorized', () => {
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);

  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline: undefined,
      quietSignature: signature,
      elapsedMs: 0,
      distrustCapMs: 3_500,
    }),
    { verdict: 'trust' },
  );
  // The writer never stores an empty signature, but a caller-constructed one is still no
  // baseline: it must trust without ever consulting the classifier (#1542 base coverage).
  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline: { provenance: 'pre-action', signature: [], comparisonKey: 'runner|app' },
      quietSignature: signature,
      elapsedMs: 0,
      distrustCapMs: 3_500,
    }),
    { verdict: 'trust' },
  );
});

test('decidePostGestureStabilityVerdict trusts a post-action baseline match at any elapsed time', () => {
  // The #3868 class: a baseline adopted mid-loop was read AFTER the gesture, so matching it is
  // what a surface at rest does. It can neither distrust nor reach the stale accept that authorizes
  // a no-effect claim — the decision has no pre-action payload to hand out.
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);

  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline: { provenance: 'post-action', signature, comparisonKey: 'runner|app' },
      quietSignature: signature,
      elapsedMs: 9_000,
      distrustCapMs: 3_500,
    }),
    { verdict: 'trust' },
  );
});

test('decidePostGestureStabilityVerdict trusts a quiet signature that differs from the baseline', () => {
  const baseline = preActionBaseline(buildInteractionSurfaceSignature(pickupSnapshot(500).nodes));
  const moved = buildInteractionSurfaceSignature(pickupSnapshot(120).nodes);

  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline,
      quietSignature: moved,
      elapsedMs: 0,
      distrustCapMs: 3_500,
    }),
    { verdict: 'trust' },
  );
});

test('decidePostGestureStabilityVerdict distrusts a quiet signature matching the baseline before the cap', () => {
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);

  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline: preActionBaseline(signature),
      quietSignature: signature,
      elapsedMs: 3_499,
      distrustCapMs: 3_500,
    }),
    { verdict: 'distrust' },
  );
});

test('decidePostGestureStabilityVerdict accepts a baseline-matching signature once the cap expires', () => {
  const signature = buildInteractionSurfaceSignature(pickupSnapshot().nodes);
  const baseline = preActionBaseline(signature);

  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline,
      quietSignature: signature,
      elapsedMs: 3_500,
      distrustCapMs: 3_500,
    }),
    { verdict: 'accept-stale', preActionBaseline: baseline },
  );
  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline,
      quietSignature: signature,
      elapsedMs: 9_000,
      distrustCapMs: 3_500,
    }),
    { verdict: 'accept-stale', preActionBaseline: baseline },
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

  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline: preActionBaseline(baseline),
      quietSignature: quiet,
      elapsedMs: 0, // first quiet match, well before any cap
      distrustCapMs: 3_500,
    }),
    { verdict: 'trust' },
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

  assert.deepEqual(
    decidePostGestureStabilityVerdict({
      baseline: preActionBaseline(baseline),
      quietSignature: quiet,
      elapsedMs: 0, // first quiet match, well before any cap
      distrustCapMs: 3_500,
    }),
    { verdict: 'trust' },
  );
});
