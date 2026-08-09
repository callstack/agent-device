import {
  filterDeviceInventoryProjection,
  LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS,
  type ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import {
  type DeviceInventoryGateway,
  type DeviceInventoryHost,
  type DeviceInventorySource,
  type InventoryPlatformModule,
  type PlatformModuleRegistry,
  type PlatformRequestScope,
  type ProviderAwareDeviceInventoryGateway,
} from '@agent-device/contracts/platform';
import {
  isApplePlatform,
  type DeviceInfo,
  type Platform,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export type ComposedDeviceInventoryGateways = Readonly<{
  providerFirst: ProviderAwareDeviceInventoryGateway;
  localOnly: DeviceInventoryGateway;
}>;

export function createComposedDeviceInventoryGateways(
  options: Readonly<{
    registry: PlatformModuleRegistry<InventoryPlatformModule>;
    loadHost: () => Promise<DeviceInventoryHost>;
    provider?: ProviderDeviceInventorySource;
  }>,
): ComposedDeviceInventoryGateways {
  const localOnly = createLocalDeviceInventoryGateway(options.registry, options.loadHost);
  const provider = options.provider;
  const discoverWithSource: ProviderAwareDeviceInventoryGateway['discoverWithSource'] = provider
    ? async (use, request, scope) => {
        scope.signal.throwIfAborted();
        const { kind: _kind, booted: _booted, ...providerRequest } = request;
        const provided = await provider.discover({ ...providerRequest }, scope.signal);
        scope.signal.throwIfAborted();
        assertProviderOutcome(provided);
        if (provided.kind === 'inventory') {
          return {
            devices: filterDeviceInventoryProjection(
              provided.devices.map((device) => ({ ...device })),
              request,
            ),
            source: 'provider',
          };
        }
        return { devices: await localOnly.discover(use, request, scope), source: 'local' };
      }
    : async (use, request, scope) => ({
        devices: await localOnly.discover(use, request, scope),
        source: 'local',
      });
  const providerFirst: ProviderAwareDeviceInventoryGateway = Object.freeze({
    discover: async (use, request, scope) =>
      (await discoverWithSource(use, request, scope)).devices,
    discoverWithSource,
  });
  return Object.freeze({ providerFirst, localOnly });
}

function createLocalDeviceInventoryGateway(
  registry: PlatformModuleRegistry<InventoryPlatformModule>,
  loadHost: () => Promise<DeviceInventoryHost>,
): DeviceInventoryGateway {
  let hostLoad: Promise<DeviceInventoryHost> | undefined;
  const requiredHost = async (): Promise<DeviceInventoryHost> => {
    hostLoad ??= loadHost();
    try {
      return await hostLoad;
    } catch (error) {
      hostLoad = undefined;
      throw error;
    }
  };
  const sourceLoads = new Map<Platform, Promise<DeviceInventorySource>>();
  const loadSource = async (family: Platform): Promise<DeviceInventorySource> => {
    const existing = sourceLoads.get(family);
    if (existing) return await existing;
    const pending = requiredHost().then(
      async (host) => await registry.get(family).loadInventory(host),
    );
    sourceLoads.set(family, pending);
    try {
      return await pending;
    } catch (error) {
      if (sourceLoads.get(family) === pending) sourceLoads.delete(family);
      throw error;
    }
  };

  return Object.freeze({
    discover: async (_use, request, scope) => {
      scope.signal.throwIfAborted();
      if (request.platform) {
        return await discoverFamily(
          loadSource,
          familyForSelector(request.platform),
          request,
          scope,
        );
      }

      const perFamily = await Promise.all(
        LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS.map(async (selector) => {
          try {
            const devices = await discoverFamily(
              loadSource,
              familyForSelector(selector),
              { ...request, platform: selector },
              scope,
            );
            return Array.isArray(devices) ? devices : [];
          } catch {
            return [];
          }
        }),
      );
      scope.signal.throwIfAborted();
      return perFamily.flat();
    },
  });
}

async function discoverFamily(
  loadSource: (family: Platform) => Promise<DeviceInventorySource>,
  family: Platform,
  request: Parameters<DeviceInventorySource['discover']>[0],
  scope: PlatformRequestScope,
): Promise<readonly DeviceInfo[]> {
  const source = await loadSource(family);
  scope.signal.throwIfAborted();
  const devices = await source.discover(request, scope);
  scope.signal.throwIfAborted();
  assertSourceFamily(family, devices);
  return filterDeviceInventoryProjection(devices, request);
}

function familyForSelector(selector: PlatformSelector): Platform {
  return isApplePlatform(selector) ? 'apple' : selector;
}

function assertSourceFamily(family: Platform, devices: readonly DeviceInfo[]): void {
  const outside = devices.find((device) => device.platform !== family);
  if (!outside) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Platform inventory source ${family} returned a ${outside.platform} device.`,
    { expectedFamily: family, actualFamily: outside.platform, deviceId: outside.id },
  );
}

function assertProviderOutcome(
  value: unknown,
): asserts value is Awaited<ReturnType<ProviderDeviceInventorySource['discover']>> {
  if (value !== null && typeof value === 'object') {
    const outcome = value as { kind?: unknown; devices?: unknown };
    if (outcome.kind === 'declined' && !('devices' in outcome)) return;
    if (outcome.kind === 'inventory' && Array.isArray(outcome.devices)) return;
  }
  throw new AppError('COMMAND_FAILED', 'Provider device inventory returned an invalid outcome.', {
    reason: 'provider_inventory_contract_violation',
  });
}
