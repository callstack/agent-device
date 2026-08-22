import {
  appStateRuntimeUses,
  appStateUse,
} from '@agent-device/contracts/platform-runtime-operations';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('appstate descriptor declares the complete readiness and foreground-state use', () => {
  const appstate = commandDescriptors.find(({ name }) => name === 'appstate');

  expect(appstate).not.toHaveProperty('capability');
  expect(appstate?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: appStateRuntimeUses,
  });
  expect(appStateRuntimeUses).toEqual([appStateUse]);
  expect(appStateUse).toEqual({
    required: ['ensureReady', 'appState'],
    preferred: [],
  });
});
