import { commandDescriptors, selectSnapshotStepUses } from '../registry.ts';
import { snapshotRuntimePlanUses } from '@agent-device/contracts/platform-runtime-operations';
import { expect, test } from 'vitest';

test('snapshot descriptor declares its complete planned capture uses with no legacy projection', () => {
  const snapshot = commandDescriptors.find(({ name }) => name === 'snapshot');

  expect(snapshot).not.toHaveProperty('capability');
  expect(snapshot).not.toHaveProperty('dispatch');
  // Plan-time consumers select the alternative from the step input the way the handler does.
  expect(snapshot?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: snapshotRuntimePlanUses,
    selectUses: selectSnapshotStepUses,
  });
  expect(snapshotRuntimePlanUses.map(({ required }) => required)).toEqual([
    ['captureSnapshot'],
    ['captureSnapshot', 'captureSnapshotWithCustomActions'],
    ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
    ['captureSnapshot', 'captureSnapshotWithCustomActions', 'captureSnapshotWithoutActiveApp'],
  ]);
});

test('diff descriptor reuses the complete snapshot plan uses with no legacy projection', () => {
  const diff = commandDescriptors.find(({ name }) => name === 'diff');

  expect(diff).not.toHaveProperty('capability');
  expect(diff).not.toHaveProperty('dispatch');
  expect(diff?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: snapshotRuntimePlanUses,
    selectUses: selectSnapshotStepUses,
  });
});
