import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import { resolveUserConfigPath } from '@agent-device/host-kit/file';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { PluginConnection, PluginConnectionContext } from './contract.ts';
import { legacyStoreManifests, storePluginCandidates } from './store.ts';

/** A plugin's connection as the client calls it: the registry adds the `host` to each context. */
export type PluginConnectionCallbacks = Readonly<{
  resolve(context: Omit<PluginConnectionContext, 'host'>): ReturnType<PluginConnection['resolve']>;
  verify(
    context: Omit<Pick<PluginConnectionContext, 'flags' | 'env' | 'host'>, 'host'>,
  ): ReturnType<PluginConnection['verify']>;
}>;

export type RegisteredConnection = PluginConnectionCallbacks &
  Readonly<{ capabilities: PluginConnection['capabilities'] }>;

// Capabilities live in the plugin, so a v2 store plugin answers only once its package has loaded.
// A client loads the store once per process through primePluginConnections; every synchronous
// reader below then answers from that registry alone. Before the store is primed, a v1 plugin
// answers from its manifest.
export type FailedPlugin = Extract<PluginInventoryEntry, { state: 'failed' }>;

type PrimedStore = Readonly<{
  connections: ReadonlyMap<string, RegisteredConnection>;
  failures: readonly FailedPlugin[];
}>;
const primed = new Map<string, PrimedStore>();

/** Loads the store's plugins into the connection registry this process reads capabilities from. */
export async function primePluginConnections(
  env: NodeJS.ProcessEnv,
  builtinProviders: readonly string[] = [],
): Promise<void> {
  if (primed.has(resolveUserConfigPath(env))) return;
  const { claimProviderIds, resolveProviderPlugins } = await import('./registry.ts');
  const resolved = await resolveProviderPlugins([
    ...claimProviderIds(builtinProviders),
    ...(await storePluginCandidates(env)),
  ]);
  primed.set(resolveUserConfigPath(env), {
    connections: resolved.connections,
    failures: resolved
      .inventory()
      .filter((entry): entry is FailedPlugin => entry.state === 'failed'),
  });
}

/** The primed connection of a store plugin, or undefined before priming or for an unknown provider. */
export function primedPluginConnection(
  provider: string,
  env: NodeJS.ProcessEnv,
): RegisteredConnection | undefined {
  return primed.get(resolveUserConfigPath(env))?.connections.get(provider);
}

/** The store plugins that failed to load, as the primed registry saw them. */
export function pluginLoadFailures(env: NodeJS.ProcessEnv): readonly FailedPlugin[] {
  return primed.get(resolveUserConfigPath(env))?.failures ?? [];
}

export function pluginConnectionCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv,
): ConnectionProviderCapabilities | undefined {
  if (provider === undefined) return undefined;
  const store = primed.get(resolveUserConfigPath(env));
  if (store) return store.connections.get(provider)?.capabilities;
  return legacyStoreManifests(env).find((plugin) => plugin.agentDevicePlugin.provider === provider)
    ?.agentDevicePlugin.connection;
}

export function pluginConnectionNames(env: NodeJS.ProcessEnv): string[] {
  const store = primed.get(resolveUserConfigPath(env));
  if (store) return [...store.connections.keys()];
  return legacyStoreManifests(env)
    .filter((plugin) => plugin.agentDevicePlugin.connection)
    .map((plugin) => plugin.agentDevicePlugin.provider);
}
