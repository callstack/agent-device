import {
  closeApplicationRuntimePlanUses,
  closeApplicationRuntimeUse,
  closeApplicationWithRuntimeHintClearUse,
  resolveCloseTargetRuntimeUse,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('close descriptor declares its native plans, including runtime-hint cleanup and the app device target check', () => {
  const close = commandDescriptors.find(({ name }) => name === 'close');

  expect(close?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: closeApplicationRuntimePlanUses,
  });
  expect(new Set(closeApplicationRuntimePlanUses)).toEqual(
    new Set([
      closeApplicationRuntimeUse,
      closeApplicationWithRuntimeHintClearUse,
      resolveCloseTargetRuntimeUse,
    ]),
  );
});
