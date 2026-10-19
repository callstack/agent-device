import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';
import { deriveDaemonCommandDescriptors } from '../derive.ts';

describe('command platform execution declaration', () => {
  test('keeps the internal execution discriminant out of daemon/public projections', () => {
    const devices = deriveDaemonCommandDescriptors(commandDescriptors).find(
      ({ command }) => command === 'devices',
    );
    expect(devices).toBeDefined();
    expect(devices).not.toHaveProperty('platformExecution');
  });
});
