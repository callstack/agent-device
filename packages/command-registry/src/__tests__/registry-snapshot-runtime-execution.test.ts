import { commandDescriptors, selectSnapshotStepUses } from '../registry.ts';
import {
  auditRuntimePlanUses,
  snapshotRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';
import { expect, test } from 'vitest';

test('snapshot descriptor declares its complete planned capture uses', () => {
  const snapshot = commandDescriptors.find(({ name }) => name === 'snapshot');

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

test('diff descriptor reuses the complete snapshot plan uses', () => {
  const diff = commandDescriptors.find(({ name }) => name === 'diff');

  expect(diff?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: snapshotRuntimePlanUses,
    selectUses: selectSnapshotStepUses,
  });
});

test('audit requires the capture and takes the native audit when the owner advertises it', () => {
  const audit = commandDescriptors.find(({ name }) => name === 'audit');
  expect(audit?.platformExecution).toEqual({ kind: 'device-runtime', uses: auditRuntimePlanUses });
  expect(
    auditRuntimePlanUses.map(({ required, conditional }) => ({ required, conditional })),
  ).toEqual([
    { required: ['captureSnapshot'], conditional: ['accessibilityAudit'] },
    {
      required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
      conditional: ['accessibilityAudit'],
    },
  ]);
});
