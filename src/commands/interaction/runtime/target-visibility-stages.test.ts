import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref, selector } from './selector-read-utils.ts';
import { throwIfOffscreenInteractionTarget } from './target-visibility-stages.ts';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import type { Point } from '@agent-device/kernel/snapshot';
import {
  coveredByTabBarSnapshot,
  createInteractionDevice,
  duplicateCoveredLabelSnapshot,
} from './__tests__/test-utils/index.ts';

test('runtime press refuses a selector that resolves to an off-screen element', async () => {
  // Closed-drawer shape: the only match sits fully left of the viewport. The
  // @ref path already refuses this; the selector path must not silently tap
  // out-of-viewport coordinates.
  const offscreenSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Explore',
      rect: { x: -320, y: 240, width: 300, height: 50 },
      hittable: true,
    },
  ]);
  const taps: unknown[] = [];
  const device = createInteractionDevice(offscreenSnapshot, {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Explore'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /off-screen element and is not safe to press/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_selector');
      // #1366: the closed-drawer shape sits fully left of the viewport, so the
      // hint names `scroll left` and steers back through the same selector.
      assert.equal(details?.scrollDirection, 'left');
      assert.match(String(details?.hint), /scroll left/i);
      assert.match(String(details?.hint), /selector/i);
      return true;
    },
  );
  assert.equal(taps.length, 0);
});

test('runtime press names a direction for a partial clip whose center is off-screen', async () => {
  // #1366 regression: the row still OVERLAPS the viewport (top edge inside), so
  // the rect-vs-viewport form yields no direction — but its tap-point center is
  // below the bottom edge, which is what the visibility guard rejects. The hint
  // must still name `scroll down` rather than falling back to the generic phrasing.
  const partialClipSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Cash',
      rect: { x: 20, y: 790, width: 200, height: 44 },
      hittable: true,
    },
  ]);
  const taps: unknown[] = [];
  const device = createInteractionDevice(partialClipSnapshot, {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Cash'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_selector');
      assert.equal(details?.scrollDirection, 'down');
      assert.match(String(details?.hint), /scroll down/i);
      // #1366 recovery must be bounded. `--until` is what bounds it now: it checks the same
      // selector between passes, so the hint names one command rather than a manual step loop.
      assert.match(String(details?.hint), /scroll down --until 'label=Cash'/);
      assert.match(String(details?.hint), /stops on the target/i);
      return true;
    },
  );
  assert.equal(taps.length, 0);
});

test('runtime click rejects refs covered by floating overlays', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(coveredByTabBarSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    /Ref @e2 is covered by another visible element/,
  );
  assert.deepEqual(calls, []);
});

test('runtime selector interactions skip covered matches when an uncovered duplicate exists', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(duplicateCoveredLabelSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await device.interactions.click(selector('label="Save draft"'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.ref, 'e2');
  assert.deepEqual(calls, [{ x: 86, y: 142 }]);
});

// #1542: throwIfOffscreenInteractionTarget is exported for ADR 0011 registry
// honesty (interaction-guarantees.ts's `offscreen` cells point their `via`
// here); this direct-import test is its real consumer, mirroring
// tryResolveRefNode in ref-target-resolution.test.ts. End-to-end rescue/refuse coverage through the
// public click/press surface lives in offscreen-double-check.test.ts.
function fakeOffscreenFailure() {
  return {
    message: 'off-screen',
    details: { reason: 'test' },
    hint: () => 'scroll toward it',
  };
}

test('throwIfOffscreenInteractionTarget: an on-screen node passes through unchanged', async () => {
  const device = createInteractionDevice(makeSnapshotState([]));
  const nodes = makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      rect: { x: 20, y: 20, width: 40, height: 40 },
    },
  ]).nodes;

  const result = await throwIfOffscreenInteractionTarget(
    device,
    { session: 'default' },
    nodes[1]!,
    nodes,
    fakeOffscreenFailure(),
  );

  assert.equal(result, nodes[1]);
});

test('throwIfOffscreenInteractionTarget: off-screen + backend confirms -> returns the node patched with the LIVE rect', async () => {
  const device = createInteractionDevice(makeSnapshotState([]), {
    confirmOffscreenTargetVisible: async () => ({ x: 30, y: 30, width: 40, height: 40 }),
  });
  const nodes = makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      rect: { x: 20, y: 2000, width: 40, height: 40 },
    },
  ]).nodes;

  const result = await throwIfOffscreenInteractionTarget(
    device,
    { session: 'default' },
    nodes[1]!,
    nodes,
    fakeOffscreenFailure(),
  );

  assert.deepEqual(result.rect, { x: 30, y: 30, width: 40, height: 40 });
  assert.equal(result.index, nodes[1]!.index);
});

test('throwIfOffscreenInteractionTarget: off-screen + no rescue -> throws with the supplied failure shape', async () => {
  const device = createInteractionDevice(makeSnapshotState([]));
  const nodes = makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      rect: { x: 20, y: 2000, width: 40, height: 40 },
    },
  ]).nodes;

  await assert.rejects(
    () =>
      throwIfOffscreenInteractionTarget(
        device,
        { session: 'default' },
        nodes[1]!,
        nodes,
        fakeOffscreenFailure(),
      ),
    /off-screen/,
  );
});
