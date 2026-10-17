import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PostGestureOutcome } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { selector } from './selector-read-utils.ts';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

const UNSETTLED: PostGestureOutcome = {
  kind: 'unsettled',
  gesture: { action: 'scroll', positionals: ['down'] },
};

const movingList = (label: string) =>
  makeSnapshotState([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Cell',
      label,
      rect: { x: 16, y: 300, width: 370, height: 52 },
      hittable: true,
    },
  ]);

// The interactive capture that misses and the full-tree retry that follows it read the same
// moving surface, so the retry's tree carries the interactive capture's unsettled outcome: neither
// the refusal nor the session's stored tree may present the miss as settled.
test('a selector press retries a miss on the full tree and keeps the unsettled gesture outcome', async () => {
  const interactive = { ...movingList('Wi-Fi'), postGestureOutcome: UNSETTLED };
  const full = movingList('Wi-Fi');
  const captures = [interactive, full];
  const taps: unknown[] = [];
  const device = createInteractionDevice(movingList('Wi-Fi'), {
    captureSnapshot: async () => ({ snapshot: captures.shift() ?? full }),
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label="General"'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'selector_not_found');
      assert.equal(details?.dispatched, 'no');
      return true;
    },
  );
  assert.deepEqual(taps, []);
  assert.deepEqual(full.postGestureOutcome, UNSETTLED);
});
