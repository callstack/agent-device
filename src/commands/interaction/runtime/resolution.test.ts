import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BackendSnapshotOptions } from '../../../backend.ts';
import { ref, selector } from './selector-read.ts';
import { resolveActionableTouchResolution } from '../../../core/interaction-targeting.ts';
import { tryResolveRefNode } from './resolution.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import type { Point } from '../../../kernel/snapshot.ts';
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
      assert.ok(typeof details?.hint === 'string');
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

test('touch resolution promotes static text inside a hittable row to the row', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeCell',
      label: 'Account row',
      rect: { x: 10, y: 20, width: 300, height: 60 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeStaticText',
      label: 'Account',
      rect: { x: 24, y: 32, width: 80, height: 20 },
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'hittable-ancestor');
  assert.equal(resolution.node.label, 'Account row');
});

test('touch resolution prefers same-rect hittable descendants over semantic targets', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeButton',
      label: 'Profile',
      rect: { x: 30, y: 40, width: 120, height: 50 },
      hittable: false,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeImage',
      identifier: 'profile-hit-area',
      rect: { x: 30, y: 40, width: 120, height: 50 },
      hittable: true,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[0]!);

  assert.equal(resolution.reason, 'same-rect-descendant');
  assert.equal(resolution.node.identifier, 'profile-hit-area');
});

test('touch resolution prevents full-screen window-like ancestors from stealing taps', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeApplication',
      label: 'Example',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeStaticText',
      label: 'Status',
      rect: { x: 24, y: 72, width: 80, height: 24 },
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[1]!);

  assert.equal(resolution.reason, 'overly-broad-ancestor');
  assert.equal(resolution.node.label, 'Status');
});

test('touch resolution falls back to the original node when no usable touch target exists', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeOther',
      label: 'Virtual item',
      hittable: false,
    },
  ]);

  const resolution = resolveActionableTouchResolution(snapshot.nodes, snapshot.nodes[0]!);

  assert.equal(resolution.reason, 'original');
  assert.equal(resolution.node.label, 'Virtual item');
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
