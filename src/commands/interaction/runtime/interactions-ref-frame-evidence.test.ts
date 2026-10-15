import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { ref } from './selector-read-utils.ts';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

// What a `@ref` interaction does with the frame evidence it is handed (ADR 0014): refuse unusable
// bounds rather than recapture positionally, refuse off-screen targets with a direction, and
// recover a label only inside the authorized frame.

function androidTextViewSnapshot(type: string, label: string) {
  return makeSnapshotState(
    [
      {
        index: 0,
        type,
        label,
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
    ],
    { backend: 'android' },
  );
}

function offscreenSnapshot(type: string, label: string, y: number) {
  return makeSnapshotState([
    { index: 0, depth: 0, type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type,
      label,
      rect: { x: 20, y, width: 180, height: 44 },
      hittable: true,
    },
  ]);
}

function assertBoundsInvalid(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
  assert.match(error.message, /Ref @e1 has no usable bounds/);
  const details = (error as { details?: Record<string, unknown> }).details;
  assert.equal(details?.reason, 'target_bounds_invalid');
  assert.equal(details?.ref, 'e1');
  return true;
}

function assertOffscreenRefusal(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
  assert.match(error.message, /off-screen/i);
  // #1366: the hint names the concrete scroll direction and steers to a selector-based retry (a
  // @ref would be rejected as expired after the scroll).
  const details = (error as { details?: Record<string, unknown> }).details;
  const hint = String(details?.hint ?? '');
  assert.match(hint, /scroll down/i);
  assert.match(hint, /selector/i);
  assert.equal(details?.reason, 'offscreen_ref');
  assert.equal(details?.scrollDirection, 'down');
  return true;
}

test('runtime press @ref fails closed when stored ref bounds are invalid (ADR 0014)', async () => {
  const taps: Point[] = [];
  let captures = 0;
  const snapshot = androidTextViewSnapshot('android.widget.TextView', 'My App');
  const device = createInteractionDevice(snapshot, {
    platform: 'android',
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot };
    },
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(ref('@e1'), { session: 'default' }),
    assertBoundsInvalid,
  );
  assert.deepEqual(taps, []);
  assert.equal(captures, 0, 'a ref with invalid bounds is refused without a positional recapture');
});

test('runtime fill @ref fails closed when stored ref bounds are invalid (ADR 0014)', async () => {
  const fills: Point[] = [];
  let captures = 0;
  const snapshot = androidTextViewSnapshot('android.widget.EditText', 'Email');
  const device = createInteractionDevice(snapshot, {
    platform: 'android',
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot };
    },
    fill: async (_context, point) => {
      fills.push(point);
    },
  });

  await assert.rejects(
    () =>
      device.interactions.fill(ref('@e1'), 'hello@example.com', {
        session: 'default',
        delayMs: 25,
      }),
    assertBoundsInvalid,
  );
  assert.deepEqual(fills, []);
  assert.equal(captures, 0, 'a ref with invalid bounds is refused without a positional recapture');
});

test('runtime press @ref fails fast when the target is off-screen', async () => {
  const taps: Point[] = [];
  const device = createInteractionDevice(
    offscreenSnapshot('XCUIElementTypeButton', 'Far item', 1200),
    {
      tap: async (_context, point) => {
        taps.push(point);
      },
    },
  );

  await assert.rejects(
    () => device.interactions.press(ref('@e2'), { session: 'default' }),
    assertOffscreenRefusal,
  );
  assert.deepEqual(taps, []);
});

test('runtime fill @ref fails fast when the target is off-screen', async () => {
  const fills: Point[] = [];
  const device = createInteractionDevice(
    offscreenSnapshot('XCUIElementTypeTextField', 'Email', 1180),
    {
      fill: async (_context, point) => {
        fills.push(point);
      },
    },
  );

  await assert.rejects(
    () => device.interactions.fill(ref('@e2'), 'hello@example.com', { session: 'default' }),
    assertOffscreenRefusal,
  );
  assert.deepEqual(fills, []);
});

test('runtime press @ref with a trailing label recovers within the authorized frame (no positional recapture)', async () => {
  // @e1's rect is unusable, but the SAME frame tree carries another node with the trailing label at
  // usable bounds. ADR 0014 label recovery resolves within the authorized frame, never by
  // recapturing a fresh tree.
  const snapshot = makeSnapshotState(
    [
      {
        index: 0,
        type: 'android.widget.TextView',
        label: 'Different',
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        type: 'android.widget.TextView',
        label: 'My App',
        rect: { x: 100, y: 200, width: 80, height: 40 },
        enabled: true,
        hittable: true,
      },
    ],
    { backend: 'android' },
  );
  const taps: Point[] = [];
  const device = createInteractionDevice(snapshot, {
    platform: 'android',
    captureSnapshot: async () => {
      throw new Error('no positional recapture: recovery stays in-frame');
    },
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(ref('@e1', { fallbackLabel: 'My App' }), {
    session: 'default',
  });

  assert.deepEqual(taps, [{ x: 140, y: 220 }]);
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.point, { x: 140, y: 220 });
  assert.deepEqual(result.resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'label-fallback',
  });
});
