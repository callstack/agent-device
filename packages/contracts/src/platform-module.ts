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

/** Whether the family must always be registered (completeness is enforced for it). */
export function isRequiredPlatform(value: Platform): value is RequiredPlatform {
  return (REQUIRED_PLATFORMS as readonly unknown[]).includes(value);
}

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

/**
 * Engine-free install-hint catalog for the optional platform families (ADR 0034): each maps to
 * its package in the maintainer-controlled `@agent-device/*` scope and the install command
 * `agent-device plugins add <package>`. It is vetted declaration data only — it never probes
 * whether an engine is installed or working, and an unknown name yields no inferred package.
 */
export type OptionalPlatformPluginDeclaration = Readonly<{
  family: OptionalPlatform;
  package: string;
  label: string;
}>;

export const HARMONYOS_PLATFORM_PLUGIN: OptionalPlatformPluginDeclaration = {
  family: 'harmonyos',
  package: '@agent-device/harmonyos',
  label: 'HarmonyOS',
};

export const VEGA_PLATFORM_PLUGIN: OptionalPlatformPluginDeclaration = {
  family: 'vega',
  package: '@agent-device/vega',
  label: 'Vega',
};

export const LINUX_PLATFORM_PLUGIN: OptionalPlatformPluginDeclaration = {
  family: 'linux',
  package: '@agent-device/linux',
  label: 'Linux desktop',
};

export const WEB_PLATFORM_PLUGIN: OptionalPlatformPluginDeclaration = {
  family: 'web',
  package: '@agent-device/web',
  label: 'Web',
};

const OPTIONAL_PLATFORM_PLUGIN_CATALOG: readonly OptionalPlatformPluginDeclaration[] = [
  HARMONYOS_PLATFORM_PLUGIN,
  VEGA_PLATFORM_PLUGIN,
  LINUX_PLATFORM_PLUGIN,
  WEB_PLATFORM_PLUGIN,
];

/** The vetted declaration for a known optional family; unknown names produce no inferred package. */
export function getOptionalPlatformPluginDeclaration(
  family: string,
): OptionalPlatformPluginDeclaration | undefined {
  return OPTIONAL_PLATFORM_PLUGIN_CATALOG.find((declaration) => declaration.family === family);
}

export function optionalPlatformPluginInstallCommand(
  declaration: OptionalPlatformPluginDeclaration,
): string {
  return `agent-device plugins add ${declaration.package}`;
}

/**
 * The typed outcome for an explicitly requested optional family whose platform module is not
 * registered (ADR 0034): `plugin-not-installed` with the family and its install hint, produced
 * before any device binding. A family the catalog does not declare gets no inferred package.
 */
export function missingOptionalPlatformModuleError(family: Platform): AppError {
  const declaration = getOptionalPlatformPluginDeclaration(family);
  if (!declaration) {
    return new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${family}`);
  }
  const installCommand = optionalPlatformPluginInstallCommand(declaration);
  return new AppError(
    'UNSUPPORTED_PLATFORM',
    `${declaration.label} platform requires the ${declaration.package} plugin.`,
    {
      reason: 'plugin-not-installed',
      family,
      package: declaration.package,
      installCommand,
      hint: `Install:\n  ${installCommand}\nThen retry the original command. If a local daemon is already running, close its sessions and run agent-device daemon stop with the same --state-dir before retrying.`,
    },
  );
}

/** Cheap family identity which may be evaluated during root composition. */
export type PlatformModuleMetadata = Readonly<{
  family: Platform;
}>;

/**
 * An immutable, total view of the registered family modules.
 *
 * Required families (`apple`, `android`) must always be present — completeness is enforced at
 * construction — while optional families (ADR 0034) may be absent; `has` reports presence and
 * `get` on an absent optional family throws the typed `plugin-not-installed` outcome.
 *
 * The registry deliberately exposes no backing Map: `ReadonlyMap` would only
 * hide mutation at compile time while a retained mutable alias could still
 * change composition after validation.
 */
export type PlatformModuleRegistry<Module extends PlatformModuleMetadata> = Readonly<{
  families: readonly Platform[];
  modules: readonly Module[];
  has(family: Platform): boolean;
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
    has: (family: Platform) => byFamily.has(family),
    get: (family: Platform) => {
      const registration = byFamily.get(family);
      if (registration) return registration;
      // An explicitly requested optional family with no registration is a missing plugin,
      // reported as a typed outcome rather than a contract violation.
      if (isOptionalPlatform(family)) throw missingOptionalPlatformModuleError(family);
      throw new TypeError(`Missing platform family registration: ${family}`);
    },
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
