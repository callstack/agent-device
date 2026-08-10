import { expect, test } from 'vitest';
import {
  assertRecordRuntimeExecution,
  screenRecordingRuntimePlanUses,
} from '@agent-device/contracts/platform';
import { commandDescriptors } from '../registry.ts';

test('record descriptor declares exactly the distinct uses selected by all three plans', () => {
  const record = commandDescriptors.find(({ name }) => name === 'record');
  expect(record?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: screenRecordingRuntimePlanUses,
  });
  expect(() => assertRecordRuntimeExecution(record?.platformExecution)).not.toThrow();
  expect(() =>
    assertRecordRuntimeExecution({
      kind: 'device-runtime',
      use: screenRecordingRuntimePlanUses[0],
    }),
  ).toThrow(/two runtime-bearing plans/);
});
