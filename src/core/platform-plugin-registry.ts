import type { Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  createPlatformModuleRegistry,
  PlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';

/**
 * The outcome for a platform family this runtime does not have (ADR 0034).
 *
 * The plugin-set composition supplies it once, when it composes its plugins, because naming the
 * package that provides a family needs the running core's version — a host read owned by
 * `@agent-device/host-kit/version`. This registry is the interactor lookup every request reaches, so
 * it stays free of that read and of the install-hint catalog: importing it evaluates neither.
 */
export type PlatformPluginAbsence = (family: Platform) => AppError;

type InteractorRegistration = { family: Platform; plugin: PlatformPlugin };

let registry: PlatformModuleRegistry<InteractorRegistration> | undefined;

/**
 * Composes `plugins` as this process's platform-plugin set and takes, once for the whole set, the
 * reporter for a family the set lacks. The set is the only registration path, so no single plugin can
 * carry its own absence policy.
 *
 * Checks every leaf platform before it changes any state: a rejected set leaves the registry and the
 * absence reporter exactly as they were, so a duplicate cannot replace the policy it came to install.
 * Throws when one platform has two claimants — inside the set or against the registered set — so
 * platform ownership cannot silently become last-writer-wins.
 * One process holds one plugin set, and `registerBuiltinPlatformPlugins` runs once.
 */
export function registerPlatformPluginSet(
  plugins: readonly PlatformPlugin[],
  reportAbsent: PlatformPluginAbsence,
  createRegistry: typeof createPlatformModuleRegistry,
): void {
  const registrations = plugins.flatMap((plugin) =>
    plugin.platforms.map((family) => ({ family, plugin })),
  );
  registry = createRegistry([...(registry?.modules ?? []), ...registrations], reportAbsent);
}

/**
 * Resolves the plugin that owns `platform`, or raises the same typed outcome the platform module
 * registry raises for a family its composition lacks (ADR 0034): an absent optional family reports
 * `plugin-not-installed` with the package that provides it and its installation command, so a caller
 * needs no guard of its own. A family with no installation row keeps the plain unsupported-platform
 * outcome with no package inferred.
 */
export function getPlugin(platform: Platform): PlatformPlugin {
  if (!registry) throw new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${platform}`);
  return registry.get(platform).plugin;
}

export function tryGetPlugin(platform: Platform): PlatformPlugin | undefined {
  return registry?.tryGet(platform)?.plugin;
}

/** @internal Registered leaf platforms in insertion order, for parity gates. */
export function registeredPlatforms(): Platform[] {
  return [...(registry?.families ?? [])];
}
