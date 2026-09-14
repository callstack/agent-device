import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point, Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { keyboardCoveredTabBarSnapshot } from '../../../../test/integration/interaction-contract/fixtures.ts';
import { ref, selector } from './selector-read-utils.ts';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

// #2589: the keyboard is its own system surface, so neither `occlusion` nor `offscreen` refuses a
// tap whose point belongs to it. These cover the consequences the shared classifier cannot express:
// which paths refuse, which disclose, and which stay silent. The tree itself is the contract
// fixtures' #2589 shape, so the refusal and the disclosure are measured on the same geometry the
// ADR 0011 cells claim.

const TAB_BAR_RECT: Rect = { x: 148, y: 791, width: 104, height: 83 };

/** The contract fixture with its app-owned button moved, so the variants stay one tree, not copies. */
function keyboardTree(params: { tabRect?: Rect } = {}): SnapshotState {
  const tabRect = params.tabRect;
  if (!tabRect) return keyboardCoveredTabBarSnapshot();
  return makeSnapshotState(
    keyboardCoveredTabBarSnapshot().nodes.map((node) =>
      node.index === 1 ? { ...node, rect: tabRect } : node,
    ),
  );
}

/**
 * Keyboard-owned rects hauled above the docking budget: the tree stops describing a keyboard the
 * bottom of the screen belongs to, which is what the app-drawn-keypad and aim cases measure against.
 */
function liftKeyboardOffBottomEdge(nodes: SnapshotState['nodes']): SnapshotState['nodes'] {
  return nodes.map((node) =>
    node.rect && (node.type === 'Keyboard' || node.type === 'Key')
      ? { ...node, rect: { ...node.rect, y: node.rect.y - 560 } }
      : node,
  );
}

function tappedDevice(snapshot: SnapshotState, calls: Point[]) {
  return createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      calls.push(point);
      return { ok: true };
    },
  });
}

test('press @ref refuses a target whose center sits behind the visible keyboard', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(keyboardTree(), calls);

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Ref @e2 is behind the visible keyboard/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'tap_keyboard_occludes_target');
      assert.equal(details?.ref, '@e2');
      assert.deepEqual(details?.rect, TAB_BAR_RECT);
      assert.deepEqual(details?.keyboardFrame, { x: 0, y: 583, width: 402, height: 291 });
      assert.match(String(details?.hint), /End editing first/);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('fill refuses with the verb matching the action', async () => {
  const device = tappedDevice(keyboardTree(), []);
  await assert.rejects(
    () => device.interactions.fill(ref('@e2'), 'hello', { session: 'default' }),
    /cannot be filled safely/,
  );
});

test('press selector refuses the same node the ref path refuses', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(keyboardTree(), calls);

  await assert.rejects(
    () => device.interactions.press(selector('label=Form'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Selector label=Form is behind the visible keyboard/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'tap_keyboard_occludes_target');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('a keyboard key is a legitimate target: pressing one still taps', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(keyboardTree(), calls);

  await device.interactions.click(ref('@e6'), { session: 'default' });

  assert.deepEqual(calls, [{ x: 202, y: 779 }]);
});

test('an element whose center stays above the key plane still taps', async () => {
  const calls: Point[] = [];
  const peeking = { x: 148, y: 470, width: 104, height: 110 };
  const device = tappedDevice(keyboardTree({ tabRect: peeking }), calls);

  await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(calls, [{ x: 200, y: 525 }]);
});

test('no keyboard in the tree means nothing to refuse', async () => {
  const calls: Point[] = [];
  const withoutKeyboard = makeSnapshotState(
    keyboardTree().nodes.filter((node) => node.type !== 'Keyboard' && node.type !== 'Key'),
  );
  const device = tappedDevice(withoutKeyboard, calls);

  await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(calls, [{ x: 200, y: 833 }]);
});

test('an app-drawn keypad that stops short of the bottom edge is not the system keyboard', async () => {
  const calls: Point[] = [];
  const appOwnedKeypad = makeSnapshotState(liftKeyboardOffBottomEdge(keyboardTree().nodes));
  const device = tappedDevice(appOwnedKeypad, calls);

  await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(calls, [{ x: 200, y: 833 }]);
});

test('a coordinate behind the keyboard taps anyway and discloses the reason', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(keyboardTree(), calls);

  const result = await device.interactions.press(
    { kind: 'point', x: 200, y: 810 },
    {
      session: 'default',
    },
  );

  assert.deepEqual(calls, [{ x: 200, y: 810 }]);
  assert.match(result.warning ?? '', /behind the visible keyboard/);
  assert.match(result.warning ?? '', /tap_keyboard_occludes_target/);
});

test('the guard reads the point the interaction dispatches, not the rect center', async () => {
  // The Form button's own center sits 3 pt above the key plane, and its interactive child owns that
  // upper region, so the point the tap dispatches is pushed down into the keyboard's band.
  const aimShifted = makeSnapshotState([
    ...keyboardCoveredTabBarSnapshot().nodes,
    {
      index: 5,
      depth: 3,
      parentIndex: 1,
      type: 'Button',
      label: 'Send',
      rect: { x: 148, y: 500, width: 104, height: 83 },
      hittable: true,
    },
  ]).nodes.map((node) =>
    node.index === 1 ? { ...node, rect: { x: 148, y: 500, width: 104, height: 160 } } : node,
  );

  const calls: Point[] = [];
  await assert.rejects(
    () =>
      tappedDevice(makeSnapshotState(aimShifted), calls).interactions.click(ref('@e2'), {
        session: 'default',
      }),
    /Ref @e2 is behind the visible keyboard/,
  );
  assert.deepEqual(calls, []);

  // The same tree with its keyboard hauled off the bottom edge shows where that tap was aiming: below
  // the key plane, which is what makes this the dispatched point's refusal rather than the center's.
  const aim: Point[] = [];
  await tappedDevice(
    makeSnapshotState(liftKeyboardOffBottomEdge(aimShifted)),
    aim,
  ).interactions.click(ref('@e2'), { session: 'default' });
  assert.equal(aim.length, 1);
  assert.ok((aim[0]?.y ?? 0) > 583, `expected the dispatched point below 583, got ${aim[0]?.y}`);
});

test('a coordinate on a reported key is the keyboard the caller asked for', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(keyboardTree(), calls);

  const result = await device.interactions.press(
    { kind: 'point', x: 160, y: 760 },
    {
      session: 'default',
    },
  );

  assert.deepEqual(calls, [{ x: 160, y: 760 }]);
  assert.equal(result.warning, undefined);
});

test('the out-of-viewport disclosure still wins on a stale-tree coordinate', async () => {
  const device = tappedDevice(keyboardTree(), []);

  const result = await device.interactions.press(
    { kind: 'point', x: 900, y: 810 },
    {
      session: 'default',
    },
  );

  assert.match(result.warning ?? '', /outside the last-known viewport/);
});
