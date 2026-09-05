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
      const ensureReady = vi.fn(async () => {});
      const operations = await withManagedDeviceScope(
        {
          device,
          owner: managedLocalRuntimeOwner('allocator'),
          fence: { token: 'fence', generation: 1 },
          ensureReady,
          run: async <T>(task: () => Promise<T>) => await task(),
        },
        async () => bindSimulatorReadiness(Object.freeze({ ensureBootedSimulator })),
      );
      await operations.ensureBootedSimulator(device);
      expect(ensureReady).toHaveBeenCalledOnce();
      await expect(
        operations.ensureBootedSimulator({ ...device, simulatorSetPath: undefined }),
      ).rejects.toMatchObject({ details: { reason: 'managed-device-transport-mismatch' } });
      expect(ensureReady).toHaveBeenCalledOnce();
      const abort = new AbortController();
      abort.abort(new Error('cancelled'));
      await expect(
        operations.ensureBootedSimulator(device, { signal: abort.signal }),
      ).rejects.toThrow('cancelled');
      expect(ensureReady).toHaveBeenCalledOnce();
      ensureReady.mockRejectedValueOnce(new Error('lease fenced'));
      await expect(operations.ensureBootedSimulator(device)).rejects.toThrow('lease fenced');
      expect(ensureReady).toHaveBeenCalledTimes(2);
    },
  );
});
