import { expect, test } from 'vitest';
import {
  findRuntimePlanUses,
  focusRuntimeUse,
  typeTextRuntimeUse,
} from '@agent-device/contracts/platform';
import { commandDescriptors } from '../registry.ts';
import { BASE_COMMAND_CAPABILITY_MATRIX } from '../../capabilities.ts';

test('find descriptor declares its complete runtime uses with no legacy projection', () => {
  const find = commandDescriptors.find(({ name }) => name === 'find');

  expect(find).not.toHaveProperty('capability');
  expect(find?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: findRuntimePlanUses,
  });
  // The complete direct-execution surface: target/read capture with the preferred element read
  // (shared with `get`), plus the two mutating legs find executes itself. Click/fill legs
  // re-invoke their own commands and carry that admission themselves.
  expect(findRuntimePlanUses.map((use) => use.required)).toEqual([
    ['captureSnapshot'],
    ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
    ['focusPoint'],
    ['typeText'],
  ]);
  expect(findRuntimePlanUses).toContain(focusRuntimeUse);
  expect(findRuntimePlanUses).toContain(typeTextRuntimeUse);
});

test('find leaves the capability matrix and both hand-maintained overlays', () => {
  expect(BASE_COMMAND_CAPABILITY_MATRIX).not.toHaveProperty('find');
});
