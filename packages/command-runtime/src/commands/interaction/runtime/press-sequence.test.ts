import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point, SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

/**
 * The multi-ref press sequence (`press @e1,@e2,...`): the plan is minted once
 * against the frame, the first key dispatches at its mint point, and each later
 * key is re-found by identity on a fresh capture and dispatched at its fresh
 * point.
 */

function keyNode(label: string, rect: { x: number; y: number }): RawSnapshotNode {
  return {
    index: 0,
    depth: 0,
    type: 'Button',
    label,
    rect: { x: rect.x, y: rect.y, width: 50, height: 50 },
    hittable: true,
  };
}

type RawSnapshotNode = Parameters<typeof makeSnapshotState>[0][number];

function keyPadSnapshot(): SnapshotState {
  return makeSnapshotState([
    keyNode('1', { x: 10, y: 100 }),
    keyNode('2', { x: 70, y: 100 }),
    keyNode('3', { x: 130, y: 100 }),
  ]);
}

/** The pad after key "1" was pressed: a PIN dot joined the tree and renumbered the refs. */
function padAfterPressSnapshot(dotCount: number): SnapshotState {
  return makeSnapshotState([
    ...Array.from({ length: dotCount }, (_, index) => ({
      index,
      depth: 0,
      type: 'Text',
      label: `PIN dot ${index}`,
      rect: { x: 10 + index * 20, y: 20, width: 20, height: 20 },
      hittable: false,
    })),
    keyNode('1', { x: 10, y: 100 }),
    keyNode('2', { x: 70, y: 140 }),
    keyNode('3', { x: 130, y: 100 }),
  ]);
}

function sequenceDevice(captures: SnapshotState[]) {
  const taps: Array<{ point: Point }> = [];
  const device = createInteractionDevice(keyPadSnapshot(), {
    captureSnapshot: async () => {
      const snapshot = captures.shift();
      if (!snapshot) throw new Error('unexpected capture');
      return { snapshot };
    },
    tap: async (_context, point) => {
      taps.push({ point });
      return { ok: true };
    },
  });
  return { device, taps };
}

test('sequence presses each key in order at its fresh position and reports the plan', async () => {
  const { device, taps } = sequenceDevice([padAfterPressSnapshot(1), padAfterPressSnapshot(2)]);

  const result = await device.interactions.press(
    { kind: 'ref', ref: '@e1' },
    { session: 'default', refs: ['e1', 'e2', 'e3'] },
  );

  assert.equal(result.kind, 'ref');
  // Key 1 at its mint point; keys 2 and 3 at the coordinates their identity
  // re-find measured on the fresh captures, not at the mint-time points.
  assert.deepEqual(taps, [
    { point: { x: 35, y: 125 } },
    { point: { x: 95, y: 165 } },
    { point: { x: 155, y: 125 } },
  ]);
  assert.deepEqual(result.sequence, {
    pressed: 3,
    refs: ['@e1', '@e2', '@e3'],
    points: [
      { x: 35, y: 125 },
      { x: 95, y: 165 },
      { x: 155, y: 125 },
    ],
  });
});

test('sequence refuses whole when one member is not on the frame, before any dispatch', async () => {
  const { device, taps } = sequenceDevice([]);

  await assert.rejects(
    device.interactions.press(
      { kind: 'ref', ref: '@e1' },
      { session: 'default', refs: ['e1', 'e9'] },
    ),
    (error: Error) => {
      assert.match(error.message, /Ref @e9 not found/);
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test('sequence refuses a remaining key whose identity left the screen', async () => {
  const { device, taps } = sequenceDevice([
    // After key 1, key "2" is gone from the surface entirely.
    makeSnapshotState([keyNode('1', { x: 10, y: 100 }), keyNode('3', { x: 130, y: 100 })]),
  ]);

  await assert.rejects(
    device.interactions.press(
      { kind: 'ref', ref: '@e1' },
      { session: 'default', refs: ['e1', 'e2', 'e3'] },
    ),
    (error: Error & { details?: Record<string, unknown> }) => {
      assert.match(error.message, /Ref @e2 no longer names a node/);
      assert.equal(error.details?.reason, 'sequence_ref_unmatched');
      assert.equal(error.details?.ref, '@e2');
      return true;
    },
  );
  // Key 1 was dispatched before the refusal; keys 2 and 3 never ran.
  assert.deepEqual(taps, [{ point: { x: 35, y: 125 } }]);
});

test('sequence refuses a remaining key whose identity names two nodes', async () => {
  // After key 2, the surface carries the "3" identity twice, so the plan
  // cannot tell which control the key names.
  const { device, taps } = sequenceDevice([
    makeSnapshotState([keyNode('3', { x: 130, y: 100 }), keyNode('3', { x: 130, y: 300 })]),
  ]);

  await assert.rejects(
    device.interactions.press(
      { kind: 'ref', ref: '@e2' },
      { session: 'default', refs: ['e2', 'e3'] },
    ),
    (error: Error) => {
      assert.match(error.message, /Ref @e3's identity now names 2 nodes/);
      return true;
    },
  );
  assert.deepEqual(taps, [{ point: { x: 95, y: 125 } }]);
});

test('sequence refuses same-point repetition options', async () => {
  const { device, taps } = sequenceDevice([]);

  await assert.rejects(
    device.interactions.press(
      { kind: 'ref', ref: '@e1' },
      { session: 'default', refs: ['e1', 'e2'], count: 2 },
    ),
    (error: AppErrorShape) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details?.option, 'count');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

type AppErrorShape = Error & { code?: string; details?: Record<string, unknown> };

test('sequence sleeps --interval-ms between keys', async () => {
  const sleeps: number[] = [];
  const device = createInteractionDevice(keyPadSnapshot(), {
    captureSnapshot: async () => ({ snapshot: padAfterPressSnapshot(1) }),
    tap: async () => ({ ok: true }),
    clock: {
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });

  await device.interactions.press(
    { kind: 'ref', ref: '@e1' },
    { session: 'default', refs: ['e1', 'e2'], intervalMs: 120 },
  );

  assert.deepEqual(sleeps, [120]);
});

test('a single-ref press carries no sequence summary', async () => {
  const taps: Array<{ point: Point }> = [];
  const device = createInteractionDevice(keyPadSnapshot(), {
    tap: async (_context, point) => {
      taps.push({ point });
      return { ok: true };
    },
  });

  const result = await device.interactions.press(
    { kind: 'ref', ref: '@e2' },
    { session: 'default' },
  );

  assert.deepEqual(taps, [{ point: { x: 95, y: 125 } }]);
  assert.equal(result.sequence, undefined);
});
