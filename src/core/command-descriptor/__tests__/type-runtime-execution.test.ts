import { expect, test } from 'vitest';
import { typeTextRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import { commandDescriptors } from '../registry.ts';

test('type descriptor declares its complete runtime use with no legacy projection', () => {
  const type = commandDescriptors.find(({ name }) => name === 'type');

  expect(type).not.toHaveProperty('capability');
  expect(type).not.toHaveProperty('dispatch');
  expect(type?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: [typeTextRuntimeUse],
  });
  expect(typeTextRuntimeUse).toEqual({
    required: ['typeText'],
    preferred: [],
  });
});

test('type keeps the traits its retired bucket did not own', () => {
  const type = commandDescriptors.find(({ name }) => name === 'type');

  expect(type).toMatchObject({
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    deviceClaimPolicy: 'require-owner',
    batchable: true,
  });
});
