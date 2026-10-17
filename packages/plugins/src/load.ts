import { pathToFileURL } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import { installedPlugins } from './store.ts';
import { resolvePluginEntry, assertUniquePluginProviders } from './manifest.ts';
import { createPluginHost, type ProviderPluginHost } from './host.ts';
import type { PluginConnection } from './connection.ts';

export type ProviderPluginRegistration = Readonly<{
  runtime: ProviderDeviceRuntime;
  platformModule: PlatformRuntimeProviderModule;
  connection?: PluginConnection;
}>;

export type PluginFactoryContext = Readonly<{
  plugin: Readonly<{ name: string; provider: string }>;
  host: ProviderPluginHost;
}>;

/**
 * What the composing root decides for every load: provider ids a plugin may not claim, and how to
 * turn a factory result that is not itself a registration into one. `adaptFactoryResult` returns
 * undefined for a result it does not own, which the loader then validates as a registration.
 */
export type PluginLoadPolicy = Readonly<{
  reservedProviders: readonly string[];
  adaptFactoryResult(
    result: unknown,
    context: PluginFactoryContext,
  ): ProviderPluginRegistration | undefined | Promise<ProviderPluginRegistration | undefined>;
}>;

export async function loadProviderPlugins(
  env: NodeJS.ProcessEnv,
  policy: PluginLoadPolicy,
  onlyProvider?: string,
): Promise<ProviderPluginRegistration[]> {
  const plugins = installedPlugins(env);
  assertUniquePluginProviders(plugins, policy.reservedProviders);
  const registrations: ProviderPluginRegistration[] = [];
  try {
    for (const plugin of plugins.filter(
      (plugin) => onlyProvider === undefined || plugin.agentDevicePlugin.provider === onlyProvider,
    )) {
      const registration = await instantiateProviderPlugin(plugin, env, policy);
      registrations.push(registration);
      validateProviderPlugin(registration, plugin);
    }
    return registrations;
  } catch (error) {
    await Promise.allSettled(registrations.map(async ({ runtime }) => await runtime.shutdown()));
    throw error;
  }
}

export async function withPluginConnection<T>(
  provider: string,
  env: NodeJS.ProcessEnv,
  policy: PluginLoadPolicy,
  runConnection: (connection: PluginConnection) => Promise<T>,
): Promise<T> {
  const registrations = await loadProviderPlugins(env, policy, provider);
  try {
    const connection = registrations.find(
      (entry) => entry.runtime.provider === provider,
    )?.connection;
    if (!connection)
      throw new AppError('INVALID_ARGS', `Plugin does not register connect: ${provider}`);
    return await runConnection(connection);
  } finally {
    await Promise.allSettled(registrations.map(async ({ runtime }) => await runtime.shutdown()));
  }
}

async function instantiateProviderPlugin(
  plugin: ReturnType<typeof installedPlugins>[number],
  env: NodeJS.ProcessEnv,
  policy: PluginLoadPolicy,
): Promise<ProviderPluginRegistration> {
  const module = await import(
    pathToFileURL(resolvePluginEntry(plugin.directory, plugin.agentDevicePlugin.entry)).href
  );
  if (typeof module.default !== 'function')
    throw new AppError('INVALID_ARGS', `Plugin must export a default factory: ${plugin.name}`);
  const host = createPluginHost(env, plugin.selection.options);
  const result: unknown = await (module.default as (host: ProviderPluginHost) => unknown)(host);
  const registration =
    (await policy.adaptFactoryResult(result, {
      plugin: { name: plugin.name, provider: plugin.agentDevicePlugin.provider },
      host,
    })) ?? (result as ProviderPluginRegistration);
  if (!registration?.runtime || typeof registration.runtime.shutdown !== 'function') {
    throw new AppError('INVALID_ARGS', `Plugin must return a provider runtime: ${plugin.name}`);
  }
  return registration;
}

function validateProviderPlugin(
  registration: ProviderPluginRegistration,
  plugin: ReturnType<typeof installedPlugins>[number],
): void {
  if (
    registration.runtime.provider !== plugin.agentDevicePlugin.provider ||
    !hasProviderFacets(registration.runtime) ||
    !matchesRuntimeOwner(registration) ||
    (plugin.agentDevicePlugin.connection &&
      (typeof registration.connection?.resolve !== 'function' ||
        typeof registration.connection?.verify !== 'function'))
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `Plugin runtime owner does not match its declaration: ${plugin.name}`,
    );
  }
}

function matchesRuntimeOwner(registration: ProviderPluginRegistration): boolean {
  const owner = registration.platformModule?.owner;
  return (
    owner?.kind === 'provider-runtime' &&
    owner.provider === registration.runtime.provider &&
    typeof owner.instance === 'string' &&
    owner.instance.trim().length > 0 &&
    typeof registration.platformModule.loadRuntime === 'function'
  );
}

function hasProviderFacets(runtime: ProviderDeviceRuntime): boolean {
  return (
    runtime.leaseLifecycle !== null &&
    typeof runtime.leaseLifecycle === 'object' &&
    (['ownsDevice', 'getInteractor', 'deviceInventoryProvider'] as const).every(
      (method) => typeof runtime[method] === 'function',
    )
  );
}
