import { inventoryUse } from '@agent-device/contracts/platform-module';
import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

describe('command platform execution declaration', () => {
  test('declares devices through the descriptor-owned inventory use', () => {
    expect(commandDescriptors.find(({ name }) => name === 'devices')?.platformExecution).toEqual({
      kind: 'inventory',
      use: inventoryUse,
    });
  });
});
