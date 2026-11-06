import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { selector } from './selector-read-utils.ts';
import { createSettleDevice } from './__tests__/settle-device-fixtures.ts';

// A settled diff keeps at most 8 removed lines: removals describe a tree the caller already read.
// The summary always keeps the true count, and `truncated` says lines were dropped.

async function pressAfterRemoving(removedRows: number) {
  const before = makeSnapshotState(
    Array.from({ length: removedRows }, (_, index) => ({
      index,
      depth: 0,
      type: 'StaticText',
      label: `Old row ${index}`,
      rect: { x: 0, y: index * 20, width: 100, height: 20 },
      hittable: true,
    })),
  );
  const after = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'New action',
      rect: { x: 0, y: 0, width: 100, height: 40 },
      hittable: true,
    },
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : after };
    },
  });
  const result = await device.interactions.press(selector('label="Old row 0"'), {
    session: 'default',
    settle: {},
  });
  const diff = result.settle?.diff;
  assert.ok(diff);
  return diff;
}

test('a settled diff with 8 removals keeps all of them', async () => {
  const diff = await pressAfterRemoving(8);

  assert.equal(diff.lines.filter((line) => line.kind === 'removed').length, 8);
  assert.equal(diff.summary.removals, 8);
  assert.equal(diff.truncated, undefined);
});

test('a settled diff with 9 removals keeps 8 and the true count', async () => {
  const diff = await pressAfterRemoving(9);

  assert.equal(diff.lines.filter((line) => line.kind === 'removed').length, 8);
  assert.equal(diff.summary.removals, 9);
  assert.equal(diff.truncated, true);
  assert.equal(diff.lines.filter((line) => line.kind === 'added').length, 1);
});
