import { expect, test } from 'vitest';
import { managedLocalRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  currentManagedDeviceScope,
  delegateManagedDeviceReadiness,
  withManagedDeviceScope,
} from './managed-device-scope.ts';

test('managed readiness scopes isolate concurrent devices and leave ordinary readiness untouched', async () => {
  const ready: string[] = [];
  const device = {
    platform: 'android' as const,
    kind: 'emulator' as const,
    id: 'one',
    name: 'one',
  };
  const managed = {
    device,
    owner: managedLocalRuntimeOwner('allocator'),
    fence: { token: 'fence', generation: 1 },
    admit: async <T>(_task: () => Promise<T>): Promise<T> => {
      throw new Error('Readiness must not recursively admit');
    },
    run: async <T>(task: () => Promise<T>) => await task(),
  };
  await Promise.all(
    ['one', 'two'].map(async (id) => {
      const selected = { ...device, id };
      await withManagedDeviceScope(
        {
          ...managed,
          device: selected,
        },
        async () => {
          await Promise.resolve();
          expect(await delegateManagedDeviceReadiness(selected)).toBe(true);
          ready.push(id);
          await expect(
            delegateManagedDeviceReadiness({ ...selected, id: 'foreign' }),
          ).rejects.toMatchObject({ details: { reason: 'managed-device-transport-mismatch' } });
        },
      );
    }),
  );
  expect(ready.sort()).toEqual(['one', 'two']);
  expect(currentManagedDeviceScope()).toBeUndefined();
  expect(await delegateManagedDeviceReadiness(device)).toBe(false);
});
