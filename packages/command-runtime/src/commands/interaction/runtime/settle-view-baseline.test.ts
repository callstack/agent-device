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

const DIALOG_LABELS = ['Device name', 'Cancel', 'OK'];

function dialogNodes(labels: readonly string[], firstIndex = 0) {
  return labels.map((label, index) => ({
    index: firstIndex + index,
    depth: firstIndex === 0 ? 0 : 1,
    ...(firstIndex === 0 ? {} : { parentIndex: 0 }),
    type: label === 'Device name' ? 'StaticText' : 'Button',
    label,
    rect: { x: 10, y: 100 + DIALOG_LABELS.indexOf(label) * 60, width: 200, height: 40 },
    hittable: true,
  }));
}

async function pressAfterSnapshot(stored: SnapshotState, settledLabels: readonly string[]) {
  const device = createSettleDevice({
    stored,
    captureSnapshot: () => ({ snapshot: makeSnapshotState(dialogNodes(settledLabels)) }),
  });
  const result = await device.interactions.press(ref('@e3'), {
    session: 'default',
    settle: {},
  });
  assert.ok(result.settle?.settled);
  return result.settle;
}

test('a settle after a full snapshot reports no removals the view change caused', async () => {
  const fullTree: SnapshotState = {
    ...makeSnapshotState([
      { index: 0, depth: 0, type: 'Group', rect: { x: 0, y: 0, width: 400, height: 800 } },
      ...dialogNodes(DIALOG_LABELS, 1),
    ]),
    presentation: {},
  };

  const settle = await pressAfterSnapshot(fullTree, DIALOG_LABELS);

  assert.equal(settle?.diff?.summary.removals, 0);
  // The tiny-tree readiness hint the settled screen earns is kept beside the view-change hint.
  assert.match(settle?.hint ?? '', /previous snapshot was a full tree.*nearly-empty tree/);
});

test('a settle after an interactive snapshot still reports what left the screen', async () => {
  const interactiveTree: SnapshotState = {
    ...makeSnapshotState(dialogNodes(DIALOG_LABELS)),
    presentation: { interactiveOnly: true },
  };

  const settle = await pressAfterSnapshot(interactiveTree, ['Cancel', 'OK']);

  assert.equal(settle?.diff?.summary.removals, 1);
  assert.doesNotMatch(settle?.hint ?? '', /full tree/);
});
