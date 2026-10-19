import {
  closeApplicationRuntimePlanUses,
  closeApplicationRuntimeUse,
  closeApplicationWithRuntimeHintClearUse,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('close descriptor declares both native plans, including exact runtime-hint cleanup', () => {
  const close = commandDescriptors.find(({ name }) => name === 'close');

  expect(close?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: closeApplicationRuntimePlanUses,
  });
  expect(new Set(closeApplicationRuntimePlanUses)).toEqual(
    new Set([closeApplicationRuntimeUse, closeApplicationWithRuntimeHintClearUse]),
  );
});
