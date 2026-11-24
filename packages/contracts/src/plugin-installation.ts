import { AppError, PLUGIN_INSTALLATION_REASONS } from '@agent-device/kernel/errors';
import type { Platform } from '@agent-device/kernel/device';
import type { OptionalPlatform } from './platform-module.ts';

import { providerPluginDeclarations } from './provider-plugin-catalog.ts';

export type PluginReleaseDeclaration = Readonly<{ package: string }>;

const DEVELOPMENT_VERSION = /^\d+\.\d+\.\d+-dev$/;
const RELEASE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-nightly(?:-0-22)?\.\d{8}\.[1-9]\d*)?$/;

/** Published first-party plugins share the core's release version. */
export function firstPartyPluginVersion(coreVersion: string): string | undefined {
  return RELEASE_VERSION.test(coreVersion) && coreVersion !== '0.0.0' ? coreVersion : undefined;
}

/** Source builds suggest an explicit tag. Bare installs require a published core version. */
export function pluginPackageSelector(
  declaration: PluginReleaseDeclaration,
  coreVersion: string,
): string {
  return DEVELOPMENT_VERSION.test(coreVersion)
    ? `${declaration.package}@nightly-0.22`
    : declaration.package;
}

export function pluginInstallCommand(
  declaration: PluginReleaseDeclaration,
  coreVersion: string,
): string {
  return `agent-device plugins add ${pluginPackageSelector(declaration, coreVersion)}`;
}

/** Installs the selected release and applies it to the next daemon. */
export function pluginInstallationHint(
  declaration: PluginReleaseDeclaration,
  coreVersion: string,
): { installCommand: string; requiredVersion?: string; hint: string } {
  const installCommand = pluginInstallCommand(declaration, coreVersion);
  const requiredVersion = firstPartyPluginVersion(coreVersion);
  return {
    installCommand,
    ...(requiredVersion ? { requiredVersion } : {}),
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
  }),
  vega: Object.freeze({
    family: 'vega',
    package: '@agent-device/vega',
    label: 'Vega',
  }),
  linux: Object.freeze({
    family: 'linux',
    package: '@agent-device/linux',
    label: 'Linux desktop',
  }),
  web: Object.freeze({
    family: 'web',
    package: '@agent-device/web',
    label: 'Web',
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
} as const satisfies PluginReleaseDeclaration & Readonly<{ label: string }>);

export type ReplayFormat = 'ad' | 'maestro';

const REPLAY_PLUGIN_INSTALLATIONS = {
  ad: {
    package: '@agent-device/replay',
    summary: 'Native .ad replay and test suites',
    installationHint:
      'Install on the daemon host for native .ad replay and all test suites. Core clients can read and send native .ad sources without this plugin.',
  },
  maestro: {
    package: '@agent-device/maestro',
    summary: 'Supported Maestro YAML commands, grammar, and runtime boundaries',
    installationHint:
      'Install on the client for source collection/export and on the daemon host for Maestro execution.',
  },
} as const;

/** Vetted installation facts for the replay format vocabulary, without loading an engine. */
export function getReplayPluginInstallation(id: ReplayFormat) {
  return { id, ...REPLAY_PLUGIN_INSTALLATIONS[id] };
}

/** Lists the same first-party packages named by command guidance and checked by releases. */
export function firstPartyPluginPackages(): string[] {
  return [
    ...providerPluginDeclarations().map(({ package: name }) => name),
    ...Object.values(OPTIONAL_PLATFORM_PLUGIN_CATALOG).map(({ package: name }) => name),
    MACOS_PLATFORM_PLUGIN_DECLARATION.package,
    ...Object.values(REPLAY_PLUGIN_INSTALLATIONS).map(({ package: name }) => name),
  ];
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
