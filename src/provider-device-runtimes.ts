import { getOptionalPlatformPluginDeclaration } from '@agent-device/contracts/plugin-installation';
import { missingPlatformPlugin } from './core/platform-plugin-absence.ts';
import type { WebPlatformSelection } from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from '@agent-device/plugins/contract';
import type {
  PluginCandidate,
  PluginRegistryPolicy,
  ProviderRegistry,
} from '@agent-device/plugins/registry';
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
  platformRegistry: Pick<ProviderRegistry, 'platforms' | 'resolvePlatform'>;
  resolveReplayBackend: import('@agent-device/plugins/replay-backend').ReplayBackendResolver;
  resolveReplayExecution: import('@agent-device/contracts/replay-execution').ReplayExecutionResolver;
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
  platformHost?: PlatformHost,
): Promise<ProviderRuntimeComposition> {
  const { storePluginCandidates, createPluginSelectionGuard } =
    await import('@agent-device/plugins/store');
  const candidates = await storePluginCandidates(host.env);
  return await composeProviderRuntime(host, candidates, {
    ...PROVIDER_PLUGIN_POLICY,
    platformHost,
    assertSelectionCurrent: createPluginSelectionGuard(candidates, host.env),
  });
}

/** Composes built-ins followed by supplied candidates without reading the plugin store. */
export async function createEmbeddedProviderRuntimeComposition(
  host: HostEnvironment,
  candidates: readonly PluginCandidate[],
  platformHost?: PlatformHost,
): Promise<ProviderRuntimeComposition> {
  return await composeProviderRuntime(host, candidates, {
    ...PROVIDER_PLUGIN_POLICY,
    platformHost,
  });
}

async function composeProviderRuntime(
  host: HostEnvironment,
  candidates: readonly PluginCandidate[],
  policy: PluginRegistryPolicy,
): Promise<ProviderRuntimeComposition> {
  const { resolveProviderPlugins, startProviderRegistry } =
    await import('@agent-device/plugins/registry');
  const [{ BUILTIN_PLATFORM_PLUGINS }, { isOptionalPlatform }] = await Promise.all([
    import('./core/interactors/register-builtins.ts'),
    import('@agent-device/contracts/platform-module'),
  ]);
  const bundledPlatforms = BUILTIN_PLATFORM_PLUGINS.flatMap((plugin) => [
    ...plugin.platforms,
  ]).filter(isOptionalPlatform);
  const resolved = await resolveProviderPlugins([
    {
      source: 'builtin',
      dormant: true,
      declaredClaims: bundledPlatforms.map((id) => ({ kind: 'platform', id })),
      load: () => undefined,
    },
    ...builtinProviderCandidates(host),
    ...candidates,
  ]);
  const registry = await startProviderRegistry(resolved, host, policy);
  return Object.freeze({
    platformRegistry: registry,
    runtimes: Object.freeze(registry.registrations.map(({ runtime }) => runtime)),
    platformModules: Object.freeze(
      registry.registrations.map(({ runtime, platformModule }) => ({
        runtime,
        module: platformModule,
      })),
    ),
    inventory: registry.inventory,
    resolveReplayBackend: registry.resolveReplayBackend,
    resolveReplayExecution: registry.resolveReplayExecution,
    shutdown: registry.close,
  });
}

export function selectWebPlatform(
  registry: Pick<ProviderRegistry, 'platforms' | 'resolvePlatform'>,
): WebPlatformSelection {
  const packageName = getOptionalPlatformPluginDeclaration('web')?.package;
  return Object.freeze({
    active: registry.platforms.find((platform) => platform.family === 'web'),
    get: () => {
      const platform = registry.resolvePlatform('web', missingPlatformPlugin, packageName);
      if (platform.family !== 'web') throw new TypeError('Expected web platform registration');
      return platform;
    },
  });
}
