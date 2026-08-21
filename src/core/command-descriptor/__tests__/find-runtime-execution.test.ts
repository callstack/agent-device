import { expect, test } from 'vitest';
import { findRuntimePlanUses } from '@agent-device/contracts/platform';
import { commandDescriptors } from '../registry.ts';
import { BASE_COMMAND_CAPABILITY_MATRIX } from '../../capabilities.ts';

test('find descriptor declares its complete runtime uses with no legacy projection', () => {
  const find = commandDescriptors.find(({ name }) => name === 'find');

  expect(find).not.toHaveProperty('capability');
  expect(find?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: findRuntimePlanUses,
  });
  // The complete direct-execution surface, action-selected so the handler binds exactly once
  // (ADR 0019 §9): the read-only element-text plans shared with `get`, the plain capture pair
  // for delegated click/fill target resolution, and the combined capture+leg uses for the focus
  // and type legs find executes itself.
  expect(findRuntimePlanUses.map((use) => use.required)).toEqual([
    ['captureSnapshot'],
    ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
    ['captureSnapshot'],
    ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
    ['captureSnapshot', 'focusPoint'],
    ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'focusPoint'],
    ['captureSnapshot', 'focusPoint', 'typeText'],
    ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'focusPoint', 'typeText'],
  ]);
});

test('find leaves the capability matrix and both hand-maintained overlays', () => {
  expect(BASE_COMMAND_CAPABILITY_MATRIX).not.toHaveProperty('find');
});
