import { LIMRUN } from '@agent-device/contracts/provider-plugin-catalog';
import { AppError, PLUGIN_INSTALLATION_REASONS } from '@agent-device/kernel/errors';
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

export type ProviderRuntimeComposition = Readonly<{
  platforms: ProviderRegistry['platforms'];
  platformLeaves: ProviderRegistry['platformLeaves'];
  assertSelectionCurrent?: PluginRegistryPolicy['assertSelectionCurrent'];
  resolveReplayBackend: import('@agent-device/plugins/replay-backend').ReplayBackendResolver;
  resolveReplayExecution: import('@agent-device/contracts/replay-execution').ReplayExecutionResolver;
  runtimes: readonly ProviderDeviceRuntime[];
  platformModules: readonly PlatformRuntimeProviderRegistration[];
  /** The registry's active, dormant, and failed plugin claims. */
  inventory: readonly PluginInventoryEntry[];
  /** Shuts down every registered runtime and runs its plugin's cleanup; the one cleanup owner. */
  shutdown(): Promise<readonly PluginCleanupOutcome[]>;
}>;

/**
 * The daemon's providers from one registry: the built-in platforms, then the plugin store. A plugin
 * that cannot register is listed in the inventory; the others still register.
 */
export async function createDaemonProviderRuntimeComposition(
  host: HostEnvironment,
  platformHost: PlatformHost,
): Promise<ProviderRuntimeComposition> {
  const { storePluginCandidates, createPluginSelectionGuard } =
    await import('@agent-device/plugins/store');
  const stored = await storePluginCandidates(host.env);
  const hostedLimrun = host.env.LIMRUN_HOSTED_ATTACHMENT_DEADLINE !== undefined;
  const candidates = hostedLimrun
    ? stored.filter(({ package: name }) => name === LIMRUN.package)
    : stored;
  return await composeProviderRuntime(
    host,
    candidates,
    {
      platformHost,
      assertSelectionCurrent: createPluginSelectionGuard(candidates, host.env),
    },
    hostedLimrun,
  );
}

/** Composes the built-in platforms followed by supplied candidates without reading the plugin store. */
export async function createEmbeddedProviderRuntimeComposition(
  host: HostEnvironment,
  candidates: readonly PluginCandidate[],
  platformHost: PlatformHost,
): Promise<ProviderRuntimeComposition> {
  return await composeProviderRuntime(host, candidates, {
    platformHost,
  });
}

async function composeProviderRuntime(
  host: HostEnvironment,
  candidates: readonly PluginCandidate[],
  policy: PluginRegistryPolicy & { platformHost: PlatformHost },
  hostedLimrun = false,
): Promise<ProviderRuntimeComposition> {
  const { resolveProviderPlugins, startProviderRegistry } =
    await import('@agent-device/plugins/registry');
  const { builtinPlatformCandidates } = await import('./platform-runtime/platform-plugins.ts');
  const resolved = await resolveProviderPlugins([...builtinPlatformCandidates(), ...candidates]);
  if (
    hostedLimrun &&
    resolved.connections.get(LIMRUN.provider)?.capabilities.acceptsHostedAttachment !== true
  ) {
    throw new AppError(
      'COMMAND_FAILED',
      'A compatible Limrun plugin is required for this session.',
      {
        reason: (candidates.length === 0
          ? PLUGIN_INSTALLATION_REASONS.notInstalled
          : PLUGIN_INSTALLATION_REASONS.unavailable
        ).reason,
      },
    );
  }
  const registry = await startProviderRegistry(resolved, host, {
    ...policy,
    hostCapabilities: async (environment) =>
      (await import('./provider-plugin-host-capabilities.ts')).createProviderHostCapabilities(
        environment,
      ),
  });
  return Object.freeze({
    platforms: registry.platforms,
    platformLeaves: registry.platformLeaves,
    assertSelectionCurrent: policy.assertSelectionCurrent,
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
