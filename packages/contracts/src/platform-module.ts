import { PLATFORMS, isPlatform, type DeviceInfo, type Platform } from '@agent-device/kernel/device';
import type { DeviceInventoryRequest } from './device-inventory.ts';
import type { DeviceInventoryHostFor, PlatformRequestScope } from './platform-runtime-host.ts';

/** Cheap family identity which may be evaluated during root composition. */
export type PlatformModuleMetadata = Readonly<{
  family: Platform;
}>;

/**
 * An immutable, total view of the six canonical family registrations.
 *
 * The registry deliberately exposes no backing Map: `ReadonlyMap` would only
 * hide mutation at compile time while a retained mutable alias could still
 * change composition after validation.
 */
export type PlatformModuleRegistry<Module extends PlatformModuleMetadata> = Readonly<{
  families: readonly Platform[];
  modules: readonly Module[];
  get(family: Platform): Module;
}>;

export function createPlatformModuleRegistry<Module extends PlatformModuleMetadata>(
  registrations: readonly Module[],
): PlatformModuleRegistry<Module> {
  const byFamily = new Map<Platform, Module>();
  for (const registration of registrations) {
    if (!isPlatform(registration.family)) {
      throw new TypeError(`Unknown platform family registration: ${String(registration.family)}`);
    }
    if (byFamily.has(registration.family)) {
      throw new TypeError(`Duplicate platform family registration: ${registration.family}`);
    }
    byFamily.set(registration.family, freezeRegistration(registration));
  }

  const missing = PLATFORMS.filter((family) => !byFamily.has(family));
  if (missing.length > 0) {
    throw new TypeError(`Missing platform family registrations: ${missing.join(', ')}`);
  }

  const families = Object.freeze([...PLATFORMS]);
  const modules = Object.freeze(families.map((family) => requiredRegistration(byFamily, family)));
  return Object.freeze({
    families,
    modules,
    get: (family: Platform) => requiredRegistration(byFamily, family),
  });
}

function freezeRegistration<Module extends PlatformModuleMetadata>(registration: Module): Module {
  return Object.freeze({ ...registration }) as Module;
}

function requiredRegistration<Module extends PlatformModuleMetadata>(
  byFamily: ReadonlyMap<Platform, Module>,
  family: Platform,
): Module {
  const registration = byFamily.get(family);
  if (!registration) {
    throw new TypeError(`Missing platform family registration: ${family}`);
  }
  return registration;
}

/** The descriptor-owned declaration for a device inventory operation. */
export type InventoryUse = Readonly<{
  kind: 'device-inventory';
}>;

export const inventoryUse: InventoryUse = Object.freeze({ kind: 'device-inventory' });

export type DeviceInventorySource = Readonly<{
  discover(
    request: Readonly<DeviceInventoryRequest>,
    scope: PlatformRequestScope,
  ): Promise<readonly DeviceInfo[]>;
}>;

export type DeviceInventoryGateway = Readonly<{
  discover(
    request: Readonly<DeviceInventoryRequest>,
    scope: PlatformRequestScope,
  ): Promise<readonly DeviceInfo[]>;
}>;

export type DeviceInventoryDiscovery = Readonly<{
  devices: readonly DeviceInfo[];
  source: 'provider' | 'local';
}>;

/** Provider-first inventory plus the selected source needed by device admission. */
export type ProviderAwareDeviceInventoryGateway = DeviceInventoryGateway &
  Readonly<{
    discoverWithSource(
      request: Readonly<DeviceInventoryRequest>,
      scope: PlatformRequestScope,
    ): Promise<DeviceInventoryDiscovery>;
  }>;

export type ComposedDeviceInventoryGateways = Readonly<{
  providerFirst: ProviderAwareDeviceInventoryGateway;
  localOnly: DeviceInventoryGateway;
}>;

/** A family module gains this interface only with an honest package-owned source. */
/** A family module receives only the host authority its inventory mechanics need. */
export type InventoryPlatformModule<Family extends Platform = Platform> = Family extends Platform
  ? PlatformModuleMetadata &
      Readonly<
        Family extends 'web'
          ? {
              family: Family;
              loadInventory(): Promise<DeviceInventorySource>;
            }
          : {
              family: Family;
              loadInventory(host: DeviceInventoryHostFor<Family>): Promise<DeviceInventorySource>;
            }
      >
  : never;
