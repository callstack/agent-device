import { expect, test } from 'vitest';
import { screenshotRuntimePlanUses } from '@agent-device/contracts/platform';
import { commandDescriptors } from '../registry.ts';

test('screenshot descriptor declares its complete runtime uses with no legacy projection', () => {
  const screenshot = commandDescriptors.find(({ name }) => name === 'screenshot');

  expect(screenshot).not.toHaveProperty('capability');
  expect(screenshot).not.toHaveProperty('dispatch');
  expect(screenshot?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: screenshotRuntimePlanUses,
  });
  expect(screenshotRuntimePlanUses).toEqual([
    { required: ['captureScreenshot'], preferred: [] },
    { required: ['captureScreenshot', 'captureSnapshot'], preferred: [] },
  ]);
});
