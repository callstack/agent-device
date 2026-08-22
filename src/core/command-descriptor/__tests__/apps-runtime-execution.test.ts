import { expect, test } from 'vitest';
import { appsRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import { commandDescriptors } from '../registry.ts';

test('apps declares the complete request-scoped runtime use', () => {
  const descriptor = commandDescriptors.find((candidate) => candidate.name === 'apps');

  expect(descriptor?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: [appsRuntimeUse],
  });
  expect(appsRuntimeUse.required).toEqual(['ensureReady', 'listApps']);
  expect(appsRuntimeUse.preferred).toEqual([]);
  expect(descriptor).not.toHaveProperty('capability');
});
