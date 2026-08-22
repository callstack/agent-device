import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Rect } from '@agent-device/kernel/snapshot';
import { ref, selector } from './selector-read-utils.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

// #1542: end-to-end coverage for the off-screen refusal double-check, next to
// resolution.ts (AGENTS.md forbids adding to daemon/handlers/__tests__/
// interaction.test.ts). Uses the same low-level runtime harness
// resolution.test.ts uses (createInteractionDevice), mocking
// `confirmOffscreenTargetVisible` directly rather than the local XCTest
// runner — the runner-level probe I/O is covered separately in
// src/daemon/__tests__/offscreen-target-probe.test.ts.

// The bulk tree's ScrollView ancestor is corrupted (squeezed to a sliver),
// so the target's rect doesn't overlap it — the guard rejects even though
// the target's OWN bulk rect ({x:126,y:136}) happens to already be correct.
function keyboardSqueezedAncestorSnapshot() {
  return makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'ScrollView',
      label: 'Checkout form',
      rect: { x: 18, y: 381, width: 366, height: 109 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Pickup',
      identifier: 'shipping-pickup',
      rect: { x: 126, y: 136, width: 75, height: 38 },
      hittable: true,
    },
  ]);
}

// The FROZEN-TREE manifestation: the whole bulk tree is pinned at
// pre-gesture values, so the target's OWN bulk rect is stale — a DIFFERENT
// place than where it actually is now. This is the shape #1542's live
// review flagged: a naive rescue that only checks "is it confirmed
// on-screen?" without also swapping in the live rect would tap the STALE
// bulk coordinate.
function frozenTreeStaleTargetSnapshot() {
  return makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Pickup',
      identifier: 'shipping-pickup',
      // Stale pre-gesture position, off the bottom of the (frozen) viewport.
      rect: { x: 20, y: 2000, width: 100, height: 40 },
      hittable: true,
    },
  ]);
}

const STALE_TARGET_REF = '@e2';
// Where the runner's live probe says the element ACTUALLY is right now.
const LIVE_RECT: Rect = { x: 150, y: 300, width: 100, height: 40 };
const LIVE_CENTER = { x: LIVE_RECT.x + LIVE_RECT.width / 2, y: LIVE_RECT.y + LIVE_RECT.height / 2 };
const STALE_CENTER = { x: 70, y: 2020 }; // center of the stale bulk rect above

test('rescue: click succeeds when confirmOffscreenTargetVisible confirms the target on-screen', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(keyboardSqueezedAncestorSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
    confirmOffscreenTargetVisible: async (_context, node) =>
      node.identifier === 'shipping-pickup' ? { x: 126, y: 136, width: 75, height: 38 } : null,
  });

  const result = await device.interactions.click(selector('id="shipping-pickup"'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  // centerOfRect rounds: (126 + 75/2, 136 + 38/2) = (163.5, 155) -> (164, 155).
  assert.deepEqual(calls, [{ x: 164, y: 155 }]);
});

test('FROZEN-TREE regression (#1542): a rescued tap lands at the LIVE rect, never the stale bulk one', async () => {
  // Counterfactual: revert resolution.ts's resolveRefInteractionTarget /
  // resolveSelectorInteractionTarget to compute the point from the
  // pre-guard `node` instead of the guard's returned (possibly
  // rescue-patched) node. This test goes red — `calls` records the STALE
  // center ({x:70,y:2020}) instead of the LIVE one asserted below.
  const calls: unknown[] = [];
  const device = createInteractionDevice(frozenTreeStaleTargetSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
    confirmOffscreenTargetVisible: async (_context, node) =>
      node.identifier === 'shipping-pickup' ? LIVE_RECT : null,
  });

  const result = await device.interactions.click(ref(STALE_TARGET_REF), { session: 'default' });

  assert.equal(result.kind, 'ref');
  assert.deepEqual(calls, [LIVE_CENTER]);
  assert.notDeepEqual(calls, [STALE_CENTER]);
  // The response's own point must agree with what was actually dispatched.
  assert.deepEqual(result.point, LIVE_CENTER);
});

test('genuine refusal: confirmOffscreenTargetVisible returns null -> still refuses, no tap', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(keyboardSqueezedAncestorSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
    confirmOffscreenTargetVisible: async () => null,
  });

  await assert.rejects(
    () => device.interactions.click(selector('id="shipping-pickup"'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /off-screen element/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('no rescue hook wired (e.g. non-iOS backend) -> refuses exactly as before', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(keyboardSqueezedAncestorSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
    // confirmOffscreenTargetVisible intentionally omitted.
  });

  await assert.rejects(
    () => device.interactions.click(selector('id="shipping-pickup"'), { session: 'default' }),
    /off-screen element/,
  );
  assert.equal(calls.length, 0);
});
