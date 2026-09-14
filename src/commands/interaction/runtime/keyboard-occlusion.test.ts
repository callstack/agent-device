import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point, RawSnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { ref, selector } from './selector-read-utils.ts';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

// #2589: the keyboard is its own system surface, so neither `occlusion` nor `offscreen` refuses a
// tap whose point belongs to it. These cover the consequences the shared classifier cannot express:
// which paths refuse, which disclose, and which stay silent.

const TAB_BAR_RECT = { x: 148, y: 791, width: 104, height: 83 };
const KEYBOARD_RECT = { x: 0, y: 583, width: 402, height: 291 };
const SPACE_KEY_RECT = { x: 40, y: 730, width: 240, height: 60 };

function keyboardNode(overrides: Partial<RawSnapshotNode> = {}): RawSnapshotNode {
  return {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'Keyboard',
    rect: KEYBOARD_RECT,
    hittable: false,
    ...overrides,
  };
}

function keyboardTree(params: { tabRect?: RawSnapshotNode['rect'] } = {}): SnapshotState {
  return makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: params.tabRect ?? TAB_BAR_RECT,
      hittable: true,
    },
    keyboardNode(),
    {
      index: 3,
      depth: 2,
      parentIndex: 2,
      type: 'Key',
      label: 'space',
      rect: SPACE_KEY_RECT,
      hittable: true,
    },
  ]);
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

test('an app-drawn keypad in the upper half is not the system keyboard', async () => {
  const calls: Point[] = [];
  const upperKeypad = makeSnapshotState([
    ...keyboardTree().nodes.slice(0, 1),
    keyboardTree().nodes[1]!,
    keyboardNode({ rect: { x: 0, y: 60, width: 402, height: 220 } }),
    keyboardTree().nodes[3]!,
  ]);
  const device = tappedDevice(upperKeypad, calls);

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
