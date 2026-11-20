import type { Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';

/**
 * The outcome for a platform family this runtime does not have (ADR 0034).
 *
 * The composition supplies it when it registers its plugins, because naming the package that
 * provides a family needs the running core's version — a host read owned by
 * `@agent-device/host-kit/version`. This registry is the interactor lookup every request reaches, so
 * it stays free of that read and of the install-hint catalog: importing it evaluates neither.
 */
export type PlatformPluginAbsence = (family: Platform) => AppError;

const registry = new Map<Platform, PlatformPlugin>();
let reportAbsence: PlatformPluginAbsence = unsupportedPlatform;

/**
 * What an absent family is before a composition has registered a plugin set and named its absence
 * outcome: unsupported, with no package inferred. A family with no installation row keeps this
 * outcome after registration too.
 */
function unsupportedPlatform(family: Platform): AppError {
  return new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${family}`);
}

/**
 * Registers `plugin` for each leaf platform it owns and records how this plugin set reports a family
 * it lacks. Throws on duplicate registration so platform ownership cannot silently become
 * last-writer-wins. One process holds one plugin set, and `registerBuiltinPlatformPlugins` runs once.
 */
export function registerPlatformPlugin(
  plugin: PlatformPlugin,
  absent: PlatformPluginAbsence,
): void {
  reportAbsence = absent;
  for (const platform of plugin.platforms) {
    if (registry.has(platform)) {
      throw new Error(`PlatformPlugin already registered for platform "${platform}"`);
    }
    registry.set(platform, plugin);
  }
}

/**
 * Resolves the plugin that owns `platform`, or raises the same typed outcome the platform module
 * registry raises for a family its composition lacks (ADR 0034): an absent optional family reports
 * `plugin-not-installed` with the package that provides it and its installation command, so a caller
 * needs no guard of its own. A family with no installation row keeps the plain unsupported-platform
 * outcome with no package inferred.
 */
export function getPlugin(platform: Platform): PlatformPlugin {
  const plugin = registry.get(platform);
  if (plugin) return plugin;
  throw reportAbsence(platform);
}

export function tryGetPlugin(platform: Platform): PlatformPlugin | undefined {
  return registry.get(platform);
}

/** @internal Registered leaf platforms in insertion order, for parity gates. */
export function registeredPlatforms(): Platform[] {
  return [...registry.keys()];
}
