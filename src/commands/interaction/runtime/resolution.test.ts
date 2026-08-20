import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BackendSnapshotOptions } from '../../../backend.ts';
import { ref, selector } from './selector-read-utils.ts';
import {
  buildRefResolution,
  throwIfOffscreenInteractionTarget,
  tryResolveRefNode,
} from './resolution.ts';
import { resolveRecordedTarget } from '@agent-device/selectors';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import type { Point } from '@agent-device/kernel/snapshot';
import { INTERACTION_ERROR_REASONS } from '@agent-device/contracts/interaction';
import {
  clickRefE2,
  coveredByTabBarSnapshot,
  createInteractionDevice,
  duplicateCoveredLabelSnapshot,
  fillableSnapshot,
  iosTabBarSnapshot,
  mapPinAnnotationSnapshot,
  nonHittableCellSnapshot,
  nonTouchableGroupSnapshot,
  selectorSnapshot,
} from './__tests__/test-utils/index.ts';

test('runtime press resolves selector targets to the actionable node center', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
      return { ok: true };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.deepEqual(calls, [{ x: 60, y: 40 }]);
  assert.equal(result.kind, 'selector');
  assert.deepEqual(result.target, { kind: 'selector', selector: 'label=Continue' });
  assert.equal(result.node?.label, 'Continue');
  assert.deepEqual(result.selectorChain, [
    'role="button" label="Continue"',
    'label="Continue"',
    'value="Continue"',
  ]);
  assert.deepEqual(result.backendResult, { ok: true });
});

test('runtime selector interactions fall back to a full snapshot when interactive refresh misses', async () => {
  const calls: Point[] = [];
  const captureOptions: Array<BackendSnapshotOptions | undefined> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async (_context, options) => {
      captureOptions.push(options);
      return {
        snapshot: options?.interactiveOnly
          ? makeSnapshotState([])
          : makeSnapshotState([
              {
                index: 0,
                depth: 0,
                type: 'XCUIElementTypeCell',
                label: 'General',
                rect: { x: 0, y: 100, width: 320, height: 44 },
                hittable: true,
              },
            ]),
      };
    },
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await device.interactions.click(selector('label=General'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.label, 'General');
  assert.deepEqual(calls, [{ x: 160, y: 122 }]);
  assert.deepEqual(captureOptions, [
    { interactiveOnly: true, includeRects: true },
    { interactiveOnly: false, includeRects: true },
  ]);
});

test('runtime selector misses carry a structured reason for retrying adapters', async () => {
  const device = createInteractionDevice(makeSnapshotState([]));

  await assert.rejects(
    () => device.interactions.press(selector('id="profile-button"'), { session: 'default' }),
    (error: unknown) => {
      assert.equal(
        (error as { details?: Record<string, unknown> }).details?.reason,
        INTERACTION_ERROR_REASONS.selectorNotFound,
      );
      return true;
    },
  );
});

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
      // #1366 recovery must be bounded: a single large (fling) scroll overshoots,
      // so the hint steers to small steps / a bounded gesture pan.
      assert.match(String(details?.hint), /small steps/i);
      assert.match(String(details?.hint), /gesture pan/i);
      return true;
    },
  );
  assert.equal(taps.length, 0);
});

test('runtime click keeps distinct tab button centers when iOS reports the tab bar as hittable', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(iosTabBarSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const refResult = await device.interactions.click(ref('@e4'), {
    session: 'default',
  });
  const selectorResult = await device.interactions.click(selector('label=Settings'), {
    session: 'default',
  });

  assert.deepEqual(calls, [
    { x: 166, y: 822 },
    { x: 257, y: 822 },
  ]);
  assert.equal(refResult.kind, 'ref');
  assert.equal(refResult.node?.label, 'Library');
  assert.equal(selectorResult.kind, 'selector');
  assert.equal(selectorResult.node?.label, 'Settings');
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

test('runtime click keeps non-button semantic targets at their own center', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(nonHittableCellSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await clickRefE2(device);

  assert.deepEqual(calls, [{ x: 70, y: 30 }]);
  assert.equal(result.kind, 'ref');
  assert.equal(result.node?.label, 'Account');
});

test('runtime press surfaces targetHittable and a hint when the final tap node is non-hittable (#1037)', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(nonHittableCellSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await device.interactions.press(ref('@e2'), { session: 'default' });

  // Press still proceeds and reports success — non-hittable is informational only.
  assert.deepEqual(calls, [{ x: 70, y: 30 }]);
  assert.equal(result.kind, 'ref');
  assert.equal(result.node?.label, 'Account');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
  assert.match(result.hint ?? '', /@ref/);
});

test('runtime press omits targetHittable and hint when the resolved node is hittable', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async () => {},
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.targetHittable, undefined);
  assert.equal(result.hint, undefined);
});

// The #1280 measured shape: a hittable, identity-empty LinearLayout row
// container whose title lives on a NON-hittable TextView child.
function identityEmptyRowSnapshot(containerType = 'LinearLayout') {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: containerType,
      rect: { x: 0, y: 100, width: 300, height: 48 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'TextView',
      label: 'Connected devices',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      hittable: false,
    },
  ]);
}

test('runtime press #1280 retarget: the response is entirely container-based; the descendant rides only the recordingTarget side channel', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(identityEmptyRowSnapshot(), {
    platform: 'android',
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await device.interactions.press(selector('role=linearlayout'), {
    session: 'default',
  });

  // Dispatch: the tap lands at the CONTAINER's center.
  assert.deepEqual(calls, [{ x: 150, y: 124 }]);
  assert.equal(result.kind, 'selector');
  // The whole runtime response describes the dispatched container — node,
  // chain, hittability. The descendant's `hittable: false` must not leak.
  assert.equal(result.node?.type, 'LinearLayout');
  assert.deepEqual(result.selectorChain, ['role="linearlayout"']);
  assert.equal(result.targetHittable, undefined);
  assert.equal(result.hint, undefined);
  // The retarget rides ONLY on the recording-only side channel.
  assert.equal(result.recordingTarget?.node.label, 'Connected devices');
  assert.deepEqual(result.recordingTarget?.selectorChain, [
    'role="textview" label="Connected devices"',
    'label="Connected devices"',
  ]);
  assert.equal(result.recordingTarget?.refLabel, 'Connected devices');
});

test('runtime fill #1280: fill is excluded from retargeting — the chain stays on the editable container and resolves for replay', async () => {
  // An identity-empty EDITABLE container (no id/label/value) with a labeled
  // non-editable TextView child. Retargeting a fill would record a chain
  // whose `editable=true` constraint the label descendant can never satisfy
  // — an unreplayable script — so fill must record as before, no retarget.
  const snapshot = identityEmptyRowSnapshot('EditText');
  const calls: Array<{ point: Point; text: string }> = [];
  const device = createInteractionDevice(snapshot, {
    platform: 'android',
    fill: async (_context, point, text) => {
      calls.push({ point, text });
    },
  });

  const result = await device.interactions.fill(selector('role=edittext'), 'hello', {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.deepEqual(calls, [{ point: { x: 150, y: 124 }, text: 'hello' }]);
  // No side channel: fill never retargets.
  assert.equal(result.recordingTarget, undefined);
  // The recorded chain belongs to the container and carries the editable
  // constraint...
  assert.deepEqual(result.selectorChain, ['role="edittext" editable=true']);
  // ...and it resolves back to the editable container on the record-time
  // tree — the saved script stays replayable.
  const resolved = resolveRecordedTarget(result.selectorChain!.join(' || '), snapshot.nodes, {
    platform: 'android',
    requireRect: true,
    allowDisambiguation: false,
  });
  assert.equal(resolved.kind === 'resolved' ? resolved.winner.type : undefined, 'EditText');
});

test('runtime fill surfaces targetHittable and a hint for a non-hittable selector match (Maps pin case, #1037)', async () => {
  const calls: Array<{ point: Point; text: string }> = [];
  const device = createInteractionDevice(mapPinAnnotationSnapshot(), {
    fill: async (_context, point, text) => {
      calls.push({ point, text });
    },
  });

  const result = await device.interactions.fill(
    selector('text="Anthropic - Headquarters"'),
    'ignored',
    { session: 'default' },
  );

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.label, 'Anthropic - Headquarters');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
  assert.deepEqual(calls, [{ point: { x: 192, y: 461 }, text: 'ignored' }]);
});

test('runtime click still promotes non-touchable nodes to hittable ancestors', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(nonTouchableGroupSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await clickRefE2(device);

  assert.deepEqual(calls, [{ x: 160, y: 60 }]);
  assert.equal(result.kind, 'ref');
  assert.equal(result.node?.label, 'Clickable group');
});

test('runtime interactions reject unsupported macOS desktop and menubar surfaces', async () => {
  const desktop = createInteractionDevice(selectorSnapshot(), {
    platform: 'macos',
    sessionMetadata: { surface: 'desktop' },
    tap: async () => {
      throw new Error('desktop click should be rejected before backend tap');
    },
  });
  await assert.rejects(
    () => desktop.interactions.click({ kind: 'point', x: 1, y: 2 }, { session: 'default' }),
    /click is not supported on macOS desktop sessions yet/,
  );
  await assert.rejects(
    () =>
      desktop.interactions.click(
        { kind: 'point', x: 1, y: 2 },
        { session: 'default', metadata: { surface: 'app' } },
      ),
    /click is not supported on macOS desktop sessions yet/,
  );

  const menubar = createInteractionDevice(fillableSnapshot(), {
    platform: 'macos',
    sessionMetadata: { surface: 'menubar' },
    fill: async () => {
      throw new Error('menubar fill should be rejected before backend fill');
    },
  });
  await assert.rejects(
    () => menubar.interactions.fill(ref('@e1'), 'hello', { session: 'default' }),
    /fill is not supported on macOS menubar sessions yet/,
  );

  let pressed = false;
  const menubarPress = createInteractionDevice(fillableSnapshot(), {
    platform: 'macos',
    sessionMetadata: { surface: 'menubar' },
    tap: async () => {
      pressed = true;
    },
  });

  await menubarPress.interactions.press(ref('@e1'), { session: 'default' });

  assert.equal(pressed, true);
});

test('runtime ref interactions fail closed when the authorized ref has no usable bounds (ADR 0014)', async () => {
  const staleSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      hittable: true,
    },
  ]);
  const calls: Point[] = [];
  let captures = 0;
  const device = createInteractionDevice(staleSnapshot, {
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot: selectorSnapshot() };
    },
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  // ADR 0014: the authorized frame's @e1 has no usable rect, so it FAILS rather
  // than recapturing and accepting the same index from a newer tree by
  // positional coincidence.
  await assert.rejects(
    () => device.interactions.click(ref('@e1'), { session: 'default' }),
    (error: unknown) => {
      assert.match((error as Error).message, /Ref @e1 not found or has no bounds/);
      return true;
    },
  );
  assert.equal(captures, 0);
  assert.deepEqual(calls, []);
});

test('tryResolveRefNode discloses exact for a resolved ref and label-fallback for label recovery', () => {
  const nodes = selectorSnapshot().nodes;

  const exact = tryResolveRefNode(nodes, '@e1', { fallbackLabel: '' });
  assert.equal(exact?.node.label, 'Continue');
  assert.deepEqual(exact?.resolution, { source: 'ref', phase: 'pre-action', kind: 'exact' });

  const recovered = tryResolveRefNode(nodes, '@e9', { fallbackLabel: 'Continue' });
  assert.equal(recovered?.node.label, 'Continue');
  assert.deepEqual(recovered?.resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'label-fallback',
  });

  assert.equal(tryResolveRefNode(nodes, '@e9', { fallbackLabel: '' }), null);
});

test('buildRefResolution is the shared exact and label-fallback disclosure constructor', () => {
  const node = selectorSnapshot().nodes[0]!;

  assert.deepEqual(buildRefResolution('e1', node, 'exact').resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'exact',
  });
  assert.deepEqual(buildRefResolution('e1', node, 'label-fallback').resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'label-fallback',
  });
});

// #1542: throwIfOffscreenInteractionTarget is exported for ADR 0011 registry
// honesty (interaction-guarantees.ts's `offscreen` cells point their `via`
// here); this direct-import test is its real consumer, mirroring
// tryResolveRefNode above. End-to-end rescue/refuse coverage through the
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
