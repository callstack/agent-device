import { PLATFORMS, isPlatform, type DeviceInfo, type Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInventoryRequest } from './device-inventory.ts';
import type { DeviceInventoryHostFor, PlatformRequestScope } from './platform-runtime-host.ts';

/**
 * Required vs optional platform families (ADR 0034). This module is the single owner of the
 * partition: `apple` and `android` are required — completeness is enforced for them — while
 * `harmonyos`, `vega`, `linux`, `web` are optional and may be absent, moved out of the packed
 * core into `platform` plugins. Every lookup consults these sets, never a second list.
 */
export const REQUIRED_PLATFORMS = ['apple', 'android'] as const;
export type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];
export const OPTIONAL_PLATFORMS = ['harmonyos', 'vega', 'linux', 'web'] as const;
export type OptionalPlatform = (typeof OPTIONAL_PLATFORMS)[number];

/** Whether the family may be absent, moved out into a `platform` plugin (ADR 0034). */
export function isOptionalPlatform(value: Platform): value is OptionalPlatform {
  return (OPTIONAL_PLATFORMS as readonly unknown[]).includes(value);
}

type AssertTrue<T extends true> = T;
type PlatformPartition = [...typeof REQUIRED_PLATFORMS, ...typeof OPTIONAL_PLATFORMS];
/**
 * Compile-time pin: the required and optional tuples partition the canonical `PLATFORMS`
 * exactly — every family is classified once, so a new family cannot skip classification.
 * Exported only so the guard stays visible at the package boundary.
 */
export type PlatformPartitionIsCanonical = AssertTrue<
  [Platform] extends [PlatformPartition[number]]
    ? [PlatformPartition[number]] extends [Platform]
      ? (typeof PLATFORMS)['length'] extends PlatformPartition['length']
        ? true
        : false
      : false
    : false
>;

/** Cheap family identity which may be evaluated during root composition. */
export type PlatformModuleMetadata = Readonly<{
  family: Platform;
}>;

/**
 * An immutable view of the registered family modules.
 *
 * Required families (`apple`, `android`) must always be present — completeness is enforced at
 * construction — while optional families (ADR 0034) may be absent, and `get` answers presence for
 * both: an absent optional family throws the typed `plugin-not-installed` outcome naming the
 * package that provides it.
 *
 * The registry deliberately exposes no backing Map: `ReadonlyMap` would only
 * hide mutation at compile time while a retained mutable alias could still
 * change composition after validation.
 */
export type PlatformModuleRegistry<Module extends PlatformModuleMetadata> = Readonly<{
  families: readonly Platform[];
  modules: readonly Module[];
  get(family: Platform): Module;
  tryGet(family: Platform): Module | undefined;
}>;

/**
 * Composes `registrations` into the presence authority for platform families.
 *
 * The caller supplies the absence reporter for this composition.
 */
export function createPlatformModuleRegistry<Module extends PlatformModuleMetadata>(
  registrations: readonly Module[],
  reportAbsent = unsupportedPlatform,
  assertSelectionCurrent?: (family: Platform) => void,
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

  // Only the required families are completeness-checked; optional families may be absent.
  const missing = REQUIRED_PLATFORMS.filter((family) => !byFamily.has(family));
  if (missing.length > 0) {
    throw new TypeError(`Missing platform family registrations: ${missing.join(', ')}`);
  }

  const families = Object.freeze(PLATFORMS.filter((family) => byFamily.has(family)));
  const modules = Object.freeze(families.map((family) => requiredRegistration(byFamily, family)));
  return Object.freeze({
    families,
    modules,
    tryGet: (family: Platform) => byFamily.get(family),
    get: (family: Platform) => {
      assertSelectionCurrent?.(family);
      const registration = byFamily.get(family);
      if (registration) return registration;
      // An explicitly requested family with no registration is a missing plugin, reported as the
      // typed outcome rather than a contract violation. Absence of a required family cannot reach
      // here: the completeness check above rejects that composition.
      throw isOptionalPlatform(family) ? reportAbsent(family) : unsupportedPlatform(family);
    },
  });
}

function unsupportedPlatform(family: Platform): AppError {
  return new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${family}`);
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

export type InstalledAppProbe = (
  device: DeviceInfo,
  appTarget: string,
) => Promise<string | undefined>;

export type ComposedDeviceInventoryGateways = Readonly<{
  providerFirst: ProviderAwareDeviceInventoryGateway;
  localOnly: DeviceInventoryGateway;
  /**
   * Optional installed-app probe that device selection uses to narrow several
   * booted simulators before committing to one. Absent where the host does not
   * provide one; selection then falls back to the ordinary inventory rules.
   */
  findInstalledApp?: InstalledAppProbe;
  /**
   * Optional resolver for the app device an open target selects on a host that holds apps as
   * devices of their own (ADR 0035). It returns `undefined` where the host device keeps the app.
   */
  resolveAppDevice?: AppDeviceResolver;
}>;

export type AppDeviceResolver = (
  host: DeviceInfo,
  appTarget: string,
) => Promise<DeviceInfo | undefined>;

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
