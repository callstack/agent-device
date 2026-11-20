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

/**
 * Which release of a plugin package the running core can install (#4694). The release workflow
 * stamps the core and its public plugins with the same nightly version, so an installation hint must
 * name that release: the bare package name on a nightly core resolves to the staged `latest`
 * placeholder rather than to the build that core works with. Every catalog that tells a user to
 * install a plugin — the provider catalog and the optional platform families ADR 0034 makes
 * installable — builds its selector here, so one channel rule cannot be fixed in one catalog and
 * missed in another. The caller supplies `coreVersion`: contracts owns vocabulary, and reading the
 * installed version is host mechanics.
 */
export type PluginReleaseDeclaration = Readonly<{
  package: string;
  // A 0.22.x-dev version carries no source branch, so the 0.22 branch's nightly tag is the shared
  // default for development builds, including main checkouts.
  nightlyTag?: 'nightly-0.22';
}>;

// The release workflow stamps the core and its public plugins with the same nightly version.
const NIGHTLY_0_22_VERSION = /^0\.22\.\d+-nightly(?:-0-22)?\.\d{8}\.[1-9]\d*$/;
const DEVELOPMENT_0_22_VERSION = /^0\.22\.\d+-dev$/;

/** The package selector a core of `coreVersion` installs: its own release, else the branch tag. */
export function pluginPackageSelector(
  declaration: PluginReleaseDeclaration,
  coreVersion: string,
): string {
  if (declaration.nightlyTag === undefined) return declaration.package;
  const version = coreVersion.trim();
  if (NIGHTLY_0_22_VERSION.test(version)) return `${declaration.package}@${version}`;
  if (DEVELOPMENT_0_22_VERSION.test(version)) {
    return `${declaration.package}@${declaration.nightlyTag}`;
  }
  return declaration.package;
}

/** The `plugins add` line that installs `declaration` for a core of `coreVersion`. */
export function pluginInstallCommand(
  declaration: PluginReleaseDeclaration,
  coreVersion: string,
): string {
  return `agent-device plugins add ${pluginPackageSelector(declaration, coreVersion)}`;
}

/**
 * The `plugins` line that repairs an installed `declaration`: `update` keeps a selector the user
 * chose, while a pinned nightly release must be added again.
 */
export function pluginRepairCommand(
  declaration: PluginReleaseDeclaration,
  coreVersion: string,
): string {
  const selector = pluginPackageSelector(declaration, coreVersion);
  const action = selector === declaration.package ? 'update' : 'add';
  return `agent-device plugins ${action} ${selector}`;
}

/**
 * Engine-free install-hint catalog for the optional platform families (ADR 0034): each family
 * maps to its package in the maintainer-controlled `@agent-device/*` scope. It is vetted
 * declaration data only — it never probes whether an engine is installed or working, and an
 * unknown family has no row and yields no inferred package. The record is total over
 * `OptionalPlatform`, so a newly optional family cannot ship without its installation row, and each
 * row uses the release-channel rule above, as the provider catalog does.
 */
export type OptionalPlatformPluginDeclaration = PluginReleaseDeclaration &
  Readonly<{
    family: OptionalPlatform;
    label: string;
  }>;

const OPTIONAL_PLATFORM_PLUGIN_CATALOG: Readonly<
  Record<OptionalPlatform, OptionalPlatformPluginDeclaration>
> = Object.freeze({
  harmonyos: Object.freeze({
    family: 'harmonyos',
    package: '@agent-device/harmonyos',
    label: 'HarmonyOS',
    nightlyTag: 'nightly-0.22',
  }),
  vega: Object.freeze({
    family: 'vega',
    package: '@agent-device/vega',
    label: 'Vega',
    nightlyTag: 'nightly-0.22',
  }),
  linux: Object.freeze({
    family: 'linux',
    package: '@agent-device/linux',
    label: 'Linux desktop',
    nightlyTag: 'nightly-0.22',
  }),
  web: Object.freeze({
    family: 'web',
    package: '@agent-device/web',
    label: 'Web',
    nightlyTag: 'nightly-0.22',
  }),
} as const satisfies Record<OptionalPlatform, OptionalPlatformPluginDeclaration>);

/**
 * The vetted declaration for an optional family, or `undefined` for any other family: the
 * required families and unknown names produce no inferred package.
 */
export function getOptionalPlatformPluginDeclaration(
  family: Platform,
): OptionalPlatformPluginDeclaration | undefined {
  return isOptionalPlatform(family) ? OPTIONAL_PLATFORM_PLUGIN_CATALOG[family] : undefined;
}

/**
 * The typed outcome for a platform family a composition does not have (ADR 0034). An optional family
 * reports `plugin-not-installed` with the package that provides it and its installation command,
 * before any device binding. The required families and unknown names have no catalog row, so they
 * keep the plain unsupported-platform outcome with no package inferred: absence of a required family
 * is a broken composition, not something a user can install.
 */
export function missingOptionalPlatformError(family: Platform, coreVersion: string): AppError {
  const declaration = getOptionalPlatformPluginDeclaration(family);
  if (!declaration) {
    return new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${family}`);
  }
  const installCommand = pluginInstallCommand(declaration, coreVersion);
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
}>;

/**
 * Composes `registrations` into the presence authority for platform families.
 *
 * `coreVersion` is the running core's version, which the typed absence outcome needs to name the
 * plugin release that core can install. The caller supplies it: reading the installed version is
 * host mechanics, which contracts does not own.
 */
export function createPlatformModuleRegistry<Module extends PlatformModuleMetadata>(
  registrations: readonly Module[],
  coreVersion: string,
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
    get: (family: Platform) => {
      const registration = byFamily.get(family);
      if (registration) return registration;
      // An explicitly requested family with no registration is a missing plugin, reported as the
      // typed outcome rather than a contract violation. Absence of a required family cannot reach
      // here: the completeness check above rejects that composition.
      throw missingOptionalPlatformError(family, coreVersion);
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
