import { inventoryUse } from '@agent-device/contracts/platform-module';
import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';
import { deriveDaemonCommandDescriptors } from '../derive.ts';

describe('command platform execution cutover', () => {
  test('declares devices through the descriptor-owned inventory use', () => {
    expect(commandDescriptors.find(({ name }) => name === 'devices')?.platformExecution).toEqual({
      kind: 'inventory',
      use: inventoryUse,
    });
  });

  test('keeps the internal cutover discriminant out of daemon/public projections', () => {
    const devices = deriveDaemonCommandDescriptors(commandDescriptors).find(
      ({ command }) => command === 'devices',
    );
    expect(devices).toBeDefined();
    expect(devices).not.toHaveProperty('platformExecution');
  });
});
