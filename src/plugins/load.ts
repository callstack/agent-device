import { pathToFileURL } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import type { ProviderPluginHost } from '../sdk/plugins.ts';
import { installedPlugins } from './store.ts';
import {
  resolvePluginEntry,
  assertUniquePluginProviders,
  RESERVED_PLUGIN_PROVIDERS,
} from './manifest.ts';
import { createPluginHost } from './host.ts';
import type { PluginConnection } from './connection.ts';
import type { WebDriverPluginOptions } from '../sdk/plugin-webdriver.ts';

type ProviderPluginRegistration = Readonly<{
  runtime: ProviderDeviceRuntime;
  platformModule: PlatformRuntimeProviderModule;
  connection?: PluginConnection;
}>;

export async function loadProviderPlugins(
  env: NodeJS.ProcessEnv,
  reservedProviders: readonly string[],
  onlyProvider?: string,
): Promise<ProviderPluginRegistration[]> {
  const plugins = installedPlugins(env);
  assertUniquePluginProviders(plugins, reservedProviders);
  const registrations: ProviderPluginRegistration[] = [];
  try {
    for (const plugin of plugins.filter(
      (plugin) => onlyProvider === undefined || plugin.agentDevicePlugin.provider === onlyProvider,
    )) {
      const registration = await instantiateProviderPlugin(plugin, env);
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
  runConnection: (connection: PluginConnection) => Promise<T>,
): Promise<T> {
  const registrations = await loadProviderPlugins(env, RESERVED_PLUGIN_PROVIDERS, provider);
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
): Promise<ProviderPluginRegistration> {
  const module = await import(
    pathToFileURL(resolvePluginEntry(plugin.directory, plugin.agentDevicePlugin.entry)).href
  );
  if (typeof module.default !== 'function')
    throw new AppError('INVALID_ARGS', `Plugin must export a default factory: ${plugin.name}`);
  const host = createPluginHost(env, plugin.selection.options);
  const result = await (
    module.default as (
      host: ProviderPluginHost,
    ) =>
      | ProviderPluginRegistration
      | { webDriver: WebDriverPluginOptions; connection?: PluginConnection }
      | Promise<
          | ProviderPluginRegistration
          | { webDriver: WebDriverPluginOptions; connection?: PluginConnection }
        >
  )(host);
  let registration: ProviderPluginRegistration;
  if (isWebDriverPluginResult(result)) {
    if (result.webDriver?.provider !== plugin.agentDevicePlugin.provider) {
      throw new AppError(
        'INVALID_ARGS',
        `WebDriver plugin provider does not match its declaration: ${plugin.name}`,
      );
    }
    const { createCloudWebDriverRuntime } = await import('@agent-device/provider-webdriver/plugin');
    const runtime = await createCloudWebDriverRuntime({
      ...result.webDriver,
      clientVersion: host.clientVersion,
    });
    registration = {
      runtime,
      platformModule: runtime.platformRuntimeModule,
      connection: result.connection,
    };
  } else registration = result;
  if (!registration?.runtime || typeof registration.runtime.shutdown !== 'function') {
    throw new AppError('INVALID_ARGS', `Plugin must return a provider runtime: ${plugin.name}`);
  }
  return registration;
}

function isWebDriverPluginResult(
  result: unknown,
): result is { webDriver: WebDriverPluginOptions; connection?: PluginConnection } {
  return typeof result === 'object' && result !== null && 'webDriver' in result;
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
