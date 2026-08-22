import { expect, test } from 'vitest';
import { focusRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import { commandDescriptors } from '../registry.ts';
import {
  BASE_COMMAND_CAPABILITY_MATRIX,
  isCommandSupportedOnDevice,
  listCapabilityCommands,
} from '../../capabilities.ts';

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

test('focus leaves the capability matrix and is admitted by facts instead', () => {
  expect(BASE_COMMAND_CAPABILITY_MATRIX).not.toHaveProperty('focus');
  // A command with no capability row is no longer refused by the legacy bucket on any device:
  // the exact owner's `focusPoint` fact is the only admission left.
  expect(
    isCommandSupportedOnDevice('focus', {
      id: 'vega-1',
      name: 'Vega',
      platform: 'vega',
      kind: 'emulator',
      target: 'tv',
      booted: true,
    }),
  ).toBe(true);
  // It stays a projected capability command, because a migrated descriptor projects from facts.
  expect(listCapabilityCommands()).toContain('focus');
});
