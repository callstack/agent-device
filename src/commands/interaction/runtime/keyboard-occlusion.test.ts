import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  Point,
  Rect,
  SnapshotKeyboardBandFact,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
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

// The producer-measured band (#2660). These run the acting paths, because the guarantee is that the
// fast path and the shared rule enter through the same door — a unit test on the resolver alone would
// leave the ref path free to consult the tree again on its way to the tap.

/** The runner's own reading of the #2589 fixture's keyboard, in the app's orientation space. */
const MEASURED_BAND: SnapshotKeyboardBandFact = {
  kind: 'visible',
  frame: { x: 0, y: 583, width: 402, height: 291 },
};

function captured(params: {
  nodes: SnapshotState['nodes'];
  keyboard?: SnapshotKeyboardBandFact;
}): SnapshotState {
  return makeSnapshotState(
    params.nodes,
    params.keyboard ? { keyboard: params.keyboard } : undefined,
  );
}

test('a measured band refuses the target the tree rule would have refused', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(
    captured({ nodes: keyboardTree().nodes, keyboard: MEASURED_BAND }),
    calls,
  );

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    (error: unknown) => {
      assert.equal(
        (error as { details?: Record<string, unknown> }).details?.reason,
        'tap_keyboard_occludes_target',
      );
      assert.deepEqual((error as { details?: Record<string, unknown> }).details?.keyboardFrame, {
        x: 0,
        y: 583,
        width: 402,
        height: 291,
      });
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('the tree rule is not consulted once the capture published a band', async () => {
  // The same screen with its keyboard hoisted off the bottom edge: the tree rule refuses to measure
  // that geometry and lets the tap through, which is what makes this pair the assertion that the
  // band came from the fact and not from the tree.
  const lifted = makeSnapshotState(liftKeyboardOffBottomEdge(keyboardTree().nodes));
  const withoutFact: Point[] = [];
  await tappedDevice(lifted, withoutFact).interactions.click(ref('@e2'), { session: 'default' });
  assert.equal(withoutFact.length, 1, 'the tree rule fails open on geometry it cannot measure');

  const withFact: Point[] = [];
  await assert.rejects(
    () =>
      tappedDevice(
        captured({ nodes: lifted.nodes, keyboard: MEASURED_BAND }),
        withFact,
      ).interactions.click(ref('@e2'), { session: 'default' }),
    /Ref @e2 is behind the visible keyboard/,
  );
  assert.deepEqual(withFact, []);
});

test('a target above the measured band still presses', async () => {
  const calls: Point[] = [];
  const above = { x: 148, y: 470, width: 104, height: 110 };
  const device = tappedDevice(
    captured({ nodes: keyboardTree({ tabRect: above }).nodes, keyboard: MEASURED_BAND }),
    calls,
  );

  await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(calls, [{ x: 200, y: 525 }]);
});

test('a measured band still excuses the keyboard key the caller named', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(
    captured({ nodes: keyboardTree().nodes, keyboard: MEASURED_BAND }),
    calls,
  );

  await device.interactions.click(ref('@e6'), { session: 'default' });

  assert.deepEqual(calls, [{ x: 202, y: 779 }]);
});

test('a measured band still reads a coordinate on a reported key as the keyboard asked for', async () => {
  const calls: Point[] = [];
  const result = await tappedDevice(
    captured({ nodes: keyboardTree().nodes, keyboard: MEASURED_BAND }),
    calls,
  ).interactions.press({ kind: 'point', x: 160, y: 760 }, { session: 'default' });

  assert.deepEqual(calls, [{ x: 160, y: 760 }]);
  assert.equal(result.warning, undefined);
});

test('a producer that found no keyboard lets the tap the stale tree would refuse', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(
    captured({ nodes: keyboardTree().nodes, keyboard: { kind: 'absent' } }),
    calls,
  );

  await device.interactions.click(ref('@e2'), { session: 'default' });

  assert.deepEqual(calls, [{ x: 200, y: 833 }]);
});

test('an unmeasurable fact leaves the acting path on the tree rule unchanged', async () => {
  const calls: Point[] = [];
  const device = tappedDevice(
    captured({
      nodes: keyboardTree().nodes,
      keyboard: { kind: 'unmeasurable', reason: 'keyboard-frame-query-timeout' },
    }),
    calls,
  );

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    /Ref @e2 is behind the visible keyboard/,
  );
  assert.deepEqual(calls, []);
});

test("a coordinate behind the measured band discloses the producer's frame", async () => {
  const result = await tappedDevice(
    captured({
      nodes: liftKeyboardOffBottomEdge(keyboardTree().nodes),
      keyboard: MEASURED_BAND,
    }),
    [],
  ).interactions.press({ kind: 'point', x: 200, y: 810 }, { session: 'default' });

  assert.match(result.warning ?? '', /keyboard frame 583\.\.874/);
});
