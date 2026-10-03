import {
  filterDeviceInventoryProjection,
  LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS,
  projectProviderDeviceInventoryRequest,
  type DeviceInventoryProvider,
  type DeviceInventoryRequest,
  type ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import type {
  ComposedDeviceInventoryGateways,
  DeviceInventoryGateway,
  InstalledAppProbe,
  ProviderAwareDeviceInventoryGateway,
} from '@agent-device/contracts/platform-module';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import {
  isApplePlatform,
  type DeviceInfo,
  type Platform,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { withDeviceInventoryContext } from '../../device-inventory-context.ts';

export type TestDeviceInventoryOptions = Readonly<{
  provider?: ProviderDeviceInventorySource;
  local?: (request: Readonly<DeviceInventoryRequest>) => Promise<readonly DeviceInfo[]>;
  findInstalledApp?: InstalledAppProbe;
}>;

const testRequestScope: PlatformRequestScope = Object.freeze({
  signal: new AbortController().signal,
  diagnostics: Object.freeze({ emit: () => {} }),
  progress: Object.freeze({ report: () => {} }),
});

type LocalDiscover = (request: Readonly<DeviceInventoryRequest>) => Promise<readonly DeviceInfo[]>;

async function discoverLocalFamily(
  localDiscover: LocalDiscover,
  platform: PlatformSelector,
  request: Readonly<DeviceInventoryRequest>,
  scope: PlatformRequestScope,
): Promise<DeviceInfo[]> {
  scope.signal.throwIfAborted();
  const family: Platform = isApplePlatform(platform) ? 'apple' : platform;
  const devices = (await localDiscover(request)).filter((device) => device.platform === family);
  return filterDeviceInventoryProjection(devices, request);
}

async function discoverLocal(
  localDiscover: LocalDiscover,
  request: Readonly<DeviceInventoryRequest>,
  scope: PlatformRequestScope,
): Promise<DeviceInfo[]> {
  scope.signal.throwIfAborted();
  if (request.platform) {
    return await discoverLocalFamily(localDiscover, request.platform, request, scope);
  }
  const perFamily = await Promise.all(
    LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS.map(async (selector) => {
      try {
        return await discoverLocalFamily(
          localDiscover,
          selector,
          { ...request, platform: selector },
          scope,
        );
      } catch {
        return [];
      }
    }),
  );
  scope.signal.throwIfAborted();
  return perFamily.flat();
}

function createTestDeviceInventoryGateways(
  options: TestDeviceInventoryOptions = {},
): ComposedDeviceInventoryGateways {
  const localDiscover = options.local ?? (async () => [] as readonly DeviceInfo[]);
  const localOnly: DeviceInventoryGateway = Object.freeze({
    discover: (request, scope) => discoverLocal(localDiscover, request, scope),
  });
  const provider = options.provider;
  const discoverWithSource: ProviderAwareDeviceInventoryGateway['discoverWithSource'] = async (
    request,
    scope,
  ) => {
    if (provider) {
      scope.signal.throwIfAborted();
      const result = await provider.discover(
        projectProviderDeviceInventoryRequest(request),
        scope.signal,
      );
      scope.signal.throwIfAborted();
      if (result.kind === 'inventory') {
        return {
          devices: filterDeviceInventoryProjection(
            result.devices.map((device) => ({ ...device })),
            request,
          ),
          source: 'provider',
        };
      }
    }
    return { devices: await localOnly.discover(request, scope), source: 'local' };
  };
  const providerFirst: ProviderAwareDeviceInventoryGateway = Object.freeze({
    discover: async (request, scope) => (await discoverWithSource(request, scope)).devices,
    discoverWithSource,
  });
  return Object.freeze({
    providerFirst,
    localOnly,
    findInstalledApp: options.findInstalledApp,
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

/** Test-only bridge for fixtures that still implement the public nullable provider port. */
export async function withTestDeviceInventoryProvider<T>(
  provider: DeviceInventoryProvider,
  task: () => Promise<T>,
): Promise<T> {
  return await withTestDeviceInventory(
    {
      provider: {
        discover: async (request, signal) => {
          signal.throwIfAborted();
          const devices = await provider(request, signal);
          return devices === null || devices === undefined
            ? { kind: 'declined' }
            : { kind: 'inventory', devices };
        },
      },
    },
    task,
  );
}
