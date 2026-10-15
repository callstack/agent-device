import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { ref } from './selector-read-utils.ts';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

// Which node an admitted press/click acts on: hittable-ancestor promotion, the macOS menubar
// wrapper, and the point the action lands on.

test('runtime click on a macOS menubar wrapper ref promotes to the same-rect menu bar item', async () => {
  const snapshot = makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'MenuBarSurface',
        label: 'Menu Bar',
        surface: 'menubar',
        rect: { x: 0, y: 0, width: 1512, height: 982 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'MenuBar',
        rect: { x: 989, y: 4.5, width: 29, height: 24 },
        hittable: true,
        surface: 'menubar',
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'MenuBarItem',
        rect: { x: 989, y: 4.5, width: 29, height: 24 },
        hittable: true,
        surface: 'menubar',
      },
    ],
    { backend: 'macos-helper' },
  );
  const taps: Point[] = [];
  const device = createInteractionDevice(snapshot, {
    platform: 'macos',
    sessionMetadata: { surface: 'menubar' },
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(taps, [{ x: 1004, y: 17 }]);
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.selectorChain, ['role="menubaritem"']);
});

test('runtime press @ref promotes a non-hittable node to its hittable ancestor before tapping', async () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      parentIndex: 2,
      type: 'XCUIElementTypeCell',
      label: 'Settings row',
      rect: { x: 20, y: 100, width: 320, height: 72 },
      enabled: true,
      hittable: true,
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeStaticText',
      label: 'Settings',
      rect: { x: 44, y: 124, width: 84, height: 20 },
      enabled: false,
      hittable: false,
    },
    {
      index: 2,
      type: 'XCUIElementTypeApplication',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      hittable: true,
    },
  ]);
  const taps: Point[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(ref('@e2'), { session: 'default' });

  assert.deepEqual(taps, [{ x: 180, y: 136 }]);
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e2' });
  // Promotion landed on a hittable ancestor, so there is nothing to flag.
  assert.equal(result.targetHittable, undefined);
  assert.equal(result.hint, undefined);
  assert.ok(Array.isArray(result.selectorChain));
});

test('runtime press @ref does not promote to a full-screen hittable ancestor', async () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      hittable: true,
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeCell',
      label: 'General',
      rect: { x: 16, y: 293, width: 370, height: 52 },
      enabled: true,
      hittable: false,
    },
  ]);
  const taps: Point[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(ref('@e2'), { session: 'default' });

  assert.deepEqual(taps, [{ x: 201, y: 319 }]);
  // #1037: the press still proceeds against the non-hittable node (no stricter resolution), but the
  // result flags it so agents can react instead of assuming the tap had a visible effect.
  assert.equal(result.kind, 'ref');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
});

test('runtime fill @ref keeps the original editable node when its parent is the hittable ancestor', async () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeCell',
      label: 'Email row',
      rect: { x: 20, y: 100, width: 320, height: 72 },
      enabled: true,
      hittable: true,
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeTextField',
      label: 'Email',
      identifier: 'auth_email',
      rect: { x: 44, y: 120, width: 200, height: 32 },
      enabled: true,
      hittable: false,
    },
  ]);
  const fills: Array<{ point: Point; text: string }> = [];
  const device = createInteractionDevice(snapshot, {
    fill: async (_context, point, text) => {
      fills.push({ point, text });
    },
  });

  const result = await device.interactions.fill(ref('@e2'), 'hello@example.com', {
    session: 'default',
  });

  assert.deepEqual(fills, [{ point: { x: 144, y: 136 }, text: 'hello@example.com' }]);
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e2' });
  assert.equal(result.node?.identifier, 'auth_email');
});
