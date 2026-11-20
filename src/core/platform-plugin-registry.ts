import { createPlatformModuleRegistry } from '@agent-device/contracts/platform-module';
import type { PlatformPlugin, PlatformPluginSet } from '@agent-device/contracts/platform-plugin';
import type { Platform } from '@agent-device/kernel/device';
import type { AppError } from '@agent-device/kernel/errors';

export type PlatformPluginAbsence = (family: Platform) => AppError;

/** Registers one runtime's builtin and managed interactors through the family registry. */
export function registerPlatformPluginSet<Plugin extends PlatformPlugin>(
  plugins: readonly Plugin[],
  reportAbsent: PlatformPluginAbsence,
  assertSelectionCurrent?: (family: Platform) => void,
): PlatformPluginSet<Plugin> {
  const registrations = plugins.flatMap((plugin) =>
    plugin.platforms.map((family) => ({ family, plugin })),
  );
  return createPlatformModuleRegistry(registrations, reportAbsent, assertSelectionCurrent);
}
