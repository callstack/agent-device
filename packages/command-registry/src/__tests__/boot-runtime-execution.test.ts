import {
  bootTargetHeadlessUse,
  bootTargetUse,
  deviceBootRuntimeUses,
} from '@agent-device/contracts/platform-runtime-operations';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('boot descriptor declares both readiness uses instead of a capability bucket', () => {
  const boot = commandDescriptors.find(({ name }) => name === 'boot');

  expect(boot).not.toHaveProperty('capability');
  expect(boot?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: deviceBootRuntimeUses,
  });
  expect(new Set(deviceBootRuntimeUses)).toEqual(new Set([bootTargetUse, bootTargetHeadlessUse]));
});
