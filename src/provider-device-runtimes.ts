import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  PluginCleanupOutcome,
  PluginInventoryEntry,
} from '@agent-device/contracts/plugin-inventory';
import type { PlatformRuntimeProviderRegistration } from './platform-runtime-gateway.ts';
import { builtinProviderCandidates } from './builtin-provider-plugins.ts';
import { PROVIDER_PLUGIN_POLICY } from './provider-plugin-policy.ts';

export type ProviderRuntimeComposition = Readonly<{
  runtimes: readonly ProviderDeviceRuntime[];
  platformModules: readonly PlatformRuntimeProviderRegistration[];
  /** Every plugin the registry saw, built-in or not, active or failed. */
  inventory: readonly PluginInventoryEntry[];
  /** Shuts down every registered runtime and runs its plugin's cleanup; the one cleanup owner. */
  shutdown(): Promise<readonly PluginCleanupOutcome[]>;
}>;

/**
 * The daemon's providers from one registry: built-in providers, then the plugin store. A plugin
 * that cannot register is listed in the inventory; the others still register.
 */
export async function createDaemonProviderRuntimeComposition(
  host: HostEnvironment,
): Promise<ProviderRuntimeComposition> {
  const { env } = host;
  // This daemon's sources: the built-in providers, then the plugin store. A host that embeds the
  // daemon picks its own candidates; the registry takes whatever candidates it is given.
  const [{ resolveProviderPlugins, startProviderRegistry }, { storePluginCandidates }] =
    await Promise.all([
      import('@agent-device/plugins/registry'),
      import('@agent-device/plugins/store'),
    ]);
  const resolved = await resolveProviderPlugins([
    ...builtinProviderCandidates(host),
    ...(await storePluginCandidates(env)),
  ]);
  const registry = await startProviderRegistry(resolved, env, PROVIDER_PLUGIN_POLICY);
  return Object.freeze({
    runtimes: Object.freeze(registry.registrations.map(({ runtime }) => runtime)),
    platformModules: Object.freeze(
      registry.registrations.map(({ runtime, platformModule }) => ({
        runtime,
        module: platformModule,
      })),
    ),
    inventory: registry.inventory,
    shutdown: registry.close,
  });
}
