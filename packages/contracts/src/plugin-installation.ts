import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { Platform } from '@agent-device/kernel/device';
import type { OptionalPlatform } from './platform-module.ts';

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

/** Installs the selected release and applies it to the next daemon. */
export function pluginInstallationHint(
  declaration: PluginReleaseDeclaration,
  coreVersion: string,
): { installCommand: string; hint: string } {
  const installCommand = pluginInstallCommand(declaration, coreVersion);
  return {
    installCommand,
    hint: `Install:\n  ${installCommand}\nThen retry your original command. If a local daemon is already running, close its sessions and run agent-device daemon stop with the same --state-dir before retrying.`,
  };
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
  return Object.hasOwn(OPTIONAL_PLATFORM_PLUGIN_CATALOG, family)
    ? OPTIONAL_PLATFORM_PLUGIN_CATALOG[family as OptionalPlatform]
    : undefined;
}

/**
 * The vetted declaration for the macOS leaf of the Apple family. macOS is not a family, so it has no
 * row in the family catalog: the bundled Apple owner delegates its macOS branches to this package.
 */
export const MACOS_PLATFORM_PLUGIN_DECLARATION = Object.freeze({
  package: '@agent-device/macos',
  label: 'macOS desktop',
  nightlyTag: 'nightly-0.22',
} as const satisfies PluginReleaseDeclaration & Readonly<{ label: string }>);

/** The `error.details.reason` a caller reads when a capability needs a plugin that is not installed. */
export const PLUGIN_INSTALLATION_REASONS = {
  // A command requires a plugin that is absent.
  notInstalled: { reason: 'plugin-not-installed', commands: ['connect', 'replay', 'test'] },
  // The selected plugin cannot supply the requested provider.
  unavailable: { reason: 'plugin-unavailable', commands: ['connect'] },
} as const satisfies ReasonTable<'plugins'>;

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
  return new AppError(
    'UNSUPPORTED_PLATFORM',
    `${declaration.label} platform requires the ${declaration.package} plugin.`,
    {
      reason: PLUGIN_INSTALLATION_REASONS.notInstalled.reason,
      family,
      package: declaration.package,
      ...pluginInstallationHint(declaration, coreVersion),
    },
  );
}

/**
 * The typed outcome for a macOS request the composition has no leaf for: `plugin-not-installed` with
 * the package that provides macOS desktop automation and its installation command. iOS and tvOS
 * requests never reach it, because the bundled Apple owner serves them.
 */
export function missingMacOsPlatformError(coreVersion: string): AppError {
  const declaration = MACOS_PLATFORM_PLUGIN_DECLARATION;
  return new AppError(
    'UNSUPPORTED_PLATFORM',
    `${declaration.label} automation requires the ${declaration.package} plugin.`,
    {
      reason: PLUGIN_INSTALLATION_REASONS.notInstalled.reason,
      family: 'apple',
      appleOs: 'macos',
      package: declaration.package,
      ...pluginInstallationHint(declaration, coreVersion),
    },
  );
}
