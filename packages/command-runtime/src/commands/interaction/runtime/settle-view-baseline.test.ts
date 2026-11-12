import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { ref } from './selector-read-utils.ts';
import { createSettleDevice } from './__tests__/settle-device-fixtures.ts';

// #4486: a full `snapshot` keeps wrapper nodes that the interactive view the settle loop reads
// omits. A press that changes nothing must not report those wrappers as removed.
//
// Budgets are injected (fake clock) — no real waiting.

const DIALOG = ['Device name', 'Cancel', 'OK'].map((label, index) => ({
  index: index + 1,
  depth: 1,
  parentIndex: 0,
  type: index === 0 ? 'StaticText' : 'Button',
  label,
  rect: { x: 10, y: 100 + index * 60, width: 200, height: 40 },
  hittable: true,
}));

function dialogWithWrapper(interactiveOnly: boolean): SnapshotState {
  return {
    ...makeSnapshotState([
      { index: 0, depth: 0, type: 'Group', rect: { x: 0, y: 0, width: 400, height: 800 } },
      ...DIALOG,
    ]),
    presentation: interactiveOnly ? { interactiveOnly: true } : {},
  };
}

async function pressAfterSnapshot(stored: SnapshotState) {
  const device = createSettleDevice({
    stored,
    // The interactive view of the unchanged dialog: the wrapper is not in it.
    captureSnapshot: () => ({
      snapshot: makeSnapshotState(DIALOG.map((node, index) => ({ ...node, index, depth: 0 }))),
    }),
  });
  const result = await device.interactions.press(ref('@e3'), {
    session: 'default',
    settle: {},
  });
  assert.ok(result.settle?.settled);
  return result.settle;
}

test('a settle after a full snapshot reports no removals the view change caused', async () => {
  const settle = await pressAfterSnapshot(dialogWithWrapper(false));

  assert.equal(settle?.diff?.summary.removals, 0);
  assert.match(settle?.hint ?? '', /previous snapshot was a full tree/);
});

test('a settle after an interactive snapshot still reports what left the screen', async () => {
  const settle = await pressAfterSnapshot(dialogWithWrapper(true));

  assert.equal(settle?.diff?.summary.removals, 1);
  assert.doesNotMatch(settle?.hint ?? '', /full tree/);
});
