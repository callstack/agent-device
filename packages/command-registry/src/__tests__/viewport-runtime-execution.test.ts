import { expect, test } from 'vitest';
import { viewportRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import { commandDescriptors } from '../registry.ts';

test('viewport descriptor declares its complete runtime use', () => {
  const viewport = commandDescriptors.find(({ name }) => name === 'viewport');

  expect(viewport?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: [viewportRuntimeUse],
  });
  expect(viewportRuntimeUse).toEqual({
    required: ['setViewport'],
    preferred: [],
  });
});
