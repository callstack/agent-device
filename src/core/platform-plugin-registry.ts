import type { Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformPlugin } from '@agent-device/contracts/platform';

const registry = new Map<Platform, PlatformPlugin>();

/**
 * Registers `plugin` for each leaf platform it owns. Throws on duplicate
 * registration so platform ownership cannot silently become last-writer-wins.
 */
export function registerPlatformPlugin(plugin: PlatformPlugin): void {
  for (const platform of plugin.platforms) {
    if (registry.has(platform)) {
      throw new Error(`PlatformPlugin already registered for platform "${platform}"`);
    }
    registry.set(platform, plugin);
  }
}

export function getPlugin(platform: Platform): PlatformPlugin {
  const plugin = registry.get(platform);
  if (!plugin) {
    throw new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${platform}`);
  }
  return plugin;
}

export function tryGetPlugin(platform: Platform): PlatformPlugin | undefined {
  return registry.get(platform);
}

/** @internal Registered leaf platforms in insertion order, for parity gates. */
export function registeredPlatforms(): Platform[] {
  return [...registry.keys()];
}
