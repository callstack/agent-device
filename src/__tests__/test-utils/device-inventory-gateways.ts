import {
  filterDeviceInventoryProjection,
  type DeviceInventoryProvider,
  type DeviceInventoryRequest,
  type ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import type {
  DeviceInventoryGateway,
  PlatformRequestScope,
  ProviderAwareDeviceInventoryGateway,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withDeviceInventoryContext } from '../../core/device-inventory-context.ts';
import type { ComposedDeviceInventoryGateways } from '../../platform-runtime-device-inventory.ts';

type TestDeviceInventoryOptions = Readonly<{
  provider?: ProviderDeviceInventorySource;
  local?: (request: Readonly<DeviceInventoryRequest>) => Promise<readonly DeviceInfo[]>;
}>;

const testRequestScope: PlatformRequestScope = Object.freeze({
  signal: new AbortController().signal,
  diagnostics: Object.freeze({ emit: () => {} }),
  progress: Object.freeze({ report: () => {} }),
});

export function createTestDeviceInventoryGateways(
  options: TestDeviceInventoryOptions = {},
): ComposedDeviceInventoryGateways {
  const localDiscover = options.local ?? (async () => []);
  const localOnly: DeviceInventoryGateway = Object.freeze({
    discover: async (_use, request) =>
      filterDeviceInventoryProjection(await localDiscover(request), request),
  });
  const providerFirst: ProviderAwareDeviceInventoryGateway = Object.freeze({
    discover: async (use, request, scope) =>
      (await providerFirst.discoverWithSource(use, request, scope)).devices,
    discoverWithSource: async (use, request, scope) => {
      const outcome = await options.provider?.discover(request, scope.signal);
      if (outcome?.kind === 'inventory') {
        return {
          devices: filterDeviceInventoryProjection(outcome.devices, request),
          source: 'provider',
        };
      }
      return {
        devices: await localOnly.discover(use, request, scope),
        source: 'local',
      };
    },
  });
  return Object.freeze({ providerFirst, localOnly });
}

/** Test-only bridge for fixtures that still implement the public nullable provider port. */
export function createTestDeviceInventoryGatewaysFromProvider(
  provider: DeviceInventoryProvider,
): ComposedDeviceInventoryGateways {
  return createTestDeviceInventoryGateways({
    provider: {
      discover: async (request, signal) => {
        signal.throwIfAborted();
        const devices = await provider(request, signal);
        return devices === null || devices === undefined
          ? { kind: 'declined' }
          : { kind: 'inventory', devices };
      },
    },
  });
}

export async function withTestDeviceInventory<T>(
  options: TestDeviceInventoryOptions,
  task: () => Promise<T>,
): Promise<T> {
  return await withDeviceInventoryContext(
    { ...createTestDeviceInventoryGateways(options), requestScope: testRequestScope },
    task,
  );
}

export async function withTestDeviceInventoryProvider<T>(
  provider: DeviceInventoryProvider,
  task: () => Promise<T>,
): Promise<T> {
  return await withDeviceInventoryContext(
    {
      ...createTestDeviceInventoryGatewaysFromProvider(provider),
      requestScope: testRequestScope,
    },
    task,
  );
}
