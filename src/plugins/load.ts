import { pathToFileURL } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import type { ProviderPluginHost } from '../sdk/plugins.ts';
import { installedPlugins } from './store.ts';
import { resolvePluginEntry, assertUniquePluginProviders } from './manifest.ts';

type ProviderPluginRegistration = Readonly<{
  runtime: ProviderDeviceRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

export async function loadProviderPlugins(
  env: NodeJS.ProcessEnv,
  reservedProviders: readonly string[],
): Promise<ProviderPluginRegistration[]> {
  const plugins = installedPlugins(env);
  assertUniquePluginProviders(plugins, reservedProviders);
  const registrations: ProviderPluginRegistration[] = [];
  try {
    for (const plugin of plugins) {
      const module = await import(
        pathToFileURL(resolvePluginEntry(plugin.directory, plugin.agentDevicePlugin.entry)).href
      );
      if (typeof module.default !== 'function')
        throw new AppError('INVALID_ARGS', `Plugin must export a default factory: ${plugin.name}`);
      const registration = await (
        module.default as (
          host: ProviderPluginHost,
        ) => ProviderPluginRegistration | Promise<ProviderPluginRegistration>
      )(
        Object.freeze({
          env: Object.freeze({ ...env }),
          options: Object.freeze({ ...plugin.selection.options }),
          createError: (code, message, details) => new AppError(code, message, details),
        }),
      );
      if (!registration?.runtime || typeof registration.runtime.shutdown !== 'function') {
        throw new AppError('INVALID_ARGS', `Plugin must return a provider runtime: ${plugin.name}`);
      }
      registrations.push(registration);
      if (
        registration.runtime.provider !== plugin.agentDevicePlugin.provider ||
        typeof registration.runtime.ownsDevice !== 'function' ||
        typeof registration.runtime.getInteractor !== 'function' ||
        typeof registration.runtime.deviceInventoryProvider !== 'function' ||
        !registration.runtime.leaseLifecycle ||
        typeof registration.runtime.leaseLifecycle !== 'object' ||
        registration.platformModule?.owner?.kind !== 'provider-runtime' ||
        registration.platformModule.owner.provider !== registration.runtime.provider ||
        typeof registration.platformModule.owner.instance !== 'string' ||
        registration.platformModule.owner.instance.trim().length === 0 ||
        typeof registration.platformModule.loadRuntime !== 'function'
      ) {
        throw new AppError(
          'INVALID_ARGS',
          `Plugin runtime owner does not match its declaration: ${plugin.name}`,
        );
      }
    }
    return registrations;
  } catch (error) {
    await Promise.allSettled(registrations.map(async ({ runtime }) => await runtime.shutdown()));
    throw error;
  }
}
