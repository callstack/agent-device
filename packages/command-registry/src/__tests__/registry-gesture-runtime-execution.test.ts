import {
  gestureRuntimePlanUses,
  swipeRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('gesture and swipe descriptors declare only the runtime uses they can select', () => {
  const gesture = commandDescriptors.find(({ name }) => name === 'gesture');
  const swipe = commandDescriptors.find(({ name }) => name === 'swipe');

  expect(gesture?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: gestureRuntimePlanUses,
  });
  expect(swipe?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: swipeRuntimePlanUses,
  });
  expect(swipeRuntimePlanUses.map(({ required }) => required)).toEqual([
    ['performGesturePlan', 'captureSnapshot'],
  ]);
});
