import { expect, test } from 'vitest';
import { viewportRuntimeUse } from '@agent-device/contracts/platform';
import { commandDescriptors } from '../registry.ts';

test('viewport descriptor declares its complete runtime use with no legacy projection', () => {
  const viewport = commandDescriptors.find(({ name }) => name === 'viewport');

  expect(viewport).not.toHaveProperty('capability');
  expect(viewport).not.toHaveProperty('dispatch');
  expect(viewport?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: [viewportRuntimeUse],
  });
  expect(viewportRuntimeUse).toEqual({
    required: ['setViewport'],
    preferred: [],
  });
});
