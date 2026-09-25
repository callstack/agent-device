import { expect, test } from 'vitest';
import { screenshotRuntimePlanUses } from '@agent-device/contracts/platform-runtime-operations';
import { commandDescriptors } from '../registry.ts';

test('screenshot descriptor declares its complete runtime uses', () => {
  const screenshot = commandDescriptors.find(({ name }) => name === 'screenshot');

  expect(screenshot?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: screenshotRuntimePlanUses,
  });
  expect(screenshotRuntimePlanUses).toEqual([
    { required: ['captureScreenshot'], preferred: [] },
    { required: ['captureScreenshot', 'captureSnapshot'], preferred: [] },
  ]);
});
