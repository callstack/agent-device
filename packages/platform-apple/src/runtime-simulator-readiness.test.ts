import { expect, test, vi } from 'vitest';
import { managedLocalRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { withManagedDeviceScope } from '@agent-device/provision-kit/managed-device-scope';
import { IOS_SIMULATOR } from './__tests__/device-fixtures.ts';
import { ensureBootedSimulator } from './core/simulator.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from './core/tool-provider.ts';
import { bindSimulatorReadiness } from './runtime-simulator-readiness.ts';

test('ordinary simulator operations preserve their binding without a readiness override', () => {
  const operations = { ensureBootedSimulator };
  expect(bindSimulatorReadiness(operations)).toBe(operations);
});

test('bound simulator readiness captures authority and refuses mismatches or failures before local boot', async () => {
  await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async () => {
        throw new Error('Unexpected local readiness');
      },
    }),
    async () => {
      const device = { ...IOS_SIMULATOR, simulatorSetPath: '/managed/set' };
      const admit = vi.fn(async (): Promise<never> => {
        throw new Error('Deep readiness must not recursively admit');
      });
      const operations = await withManagedDeviceScope(
        {
          device,
          owner: managedLocalRuntimeOwner('allocator'),
          fence: { token: 'fence', generation: 1 },
          admit,
          run: async <T>(task: () => Promise<T>) => await task(),
        },
        async () => bindSimulatorReadiness(Object.freeze({ ensureBootedSimulator })),
      );
      await operations.ensureBootedSimulator(device);
      expect(admit).not.toHaveBeenCalled();
      await expect(
        operations.ensureBootedSimulator({ ...device, simulatorSetPath: undefined }),
      ).rejects.toMatchObject({ details: { reason: 'managed-device-transport-mismatch' } });
      expect(admit).not.toHaveBeenCalled();
      const abort = new AbortController();
      abort.abort(new Error('cancelled'));
      await expect(
        operations.ensureBootedSimulator(device, { signal: abort.signal }),
      ).rejects.toThrow('cancelled');
      expect(admit).not.toHaveBeenCalled();
    },
  );
});
