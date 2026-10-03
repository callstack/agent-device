import { appLogRuntimePlanUses } from '@agent-device/contracts/logs-runtime-plan';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('logs descriptor declares exactly the distinct uses selected by all seven plans', () => {
  const logs = commandDescriptors.find(({ name }) => name === 'logs');
  expect(logs?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: appLogRuntimePlanUses,
  });
});
