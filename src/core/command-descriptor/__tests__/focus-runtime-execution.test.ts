import { expect, test } from 'vitest';
import { focusRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import { commandDescriptors } from '../registry.ts';
import { listRuntimeFactCommands } from '../../capabilities.ts';

test('focus descriptor declares its complete runtime use with no legacy projection', () => {
  const focus = commandDescriptors.find(({ name }) => name === 'focus');

  expect(focus).not.toHaveProperty('capability');
  expect(focus).not.toHaveProperty('dispatch');
  expect(focus?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: [focusRuntimeUse],
  });
  expect(focusRuntimeUse).toEqual({
    required: ['focusPoint'],
    preferred: [],
  });
});

test('focus keeps the traits its retired bucket did not own', () => {
  const focus = commandDescriptors.find(({ name }) => name === 'focus');

  // The Android blocking-dialog guard is admission-independent: it survived the cutover because
  // it describes when the command may run, not which platform executes it.
  expect(focus).toMatchObject({
    daemon: {
      route: 'generic',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    deviceClaimPolicy: 'require-owner',
    batchable: true,
  });
});

test('focus is projected into runtime-fact inventory', () => {
  expect(listRuntimeFactCommands()).toContain('focus');
});
