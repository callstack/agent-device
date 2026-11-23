import { PROVIDER_INVENTORY_REASONS } from '@agent-device/contracts/device';
import { pluginInstallationHint } from '@agent-device/contracts/plugin-installation';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import { getProviderPluginDeclaration } from '@agent-device/contracts/provider-plugin-catalog';
import { readVersion } from '@agent-device/host-kit/version';
import { readLeaseProvider } from '@agent-device/kernel/contracts';
import {
  AppError,
  normalizeError,
  type DaemonError,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import { dormantProviderAdmissionError } from './request-admission.ts';

const PROVIDER_RUNTIME_REASONS = {
  // The daemon has no runtime for the requested provider. Inspect failedPlugins or install the named managed plugin.
  notRegistered: { reason: 'provider-not-registered' },
} as const satisfies ReasonTable<'provider runtime admission'>;

export function providerRuntimeAdmissionError(
  provider: string,
  route: 'allocation' | 'catalog',
  registeredProviders: readonly string[] = [],
  pluginInventory: readonly PluginInventoryEntry[] = [],
): AppError | undefined {
  if (registeredProviders.includes(provider)) return undefined;
  const dormant = dormantProviderAdmissionError(provider, pluginInventory);
  if (dormant) return dormant;
  const declaration = getProviderPluginDeclaration(provider);
  const failures = pluginInventory.flatMap((plugin) =>
    plugin.state === 'failed' &&
    plugin.backend === undefined &&
    plugin.platform === undefined &&
    (plugin.provider === provider ||
      (declaration !== undefined && plugin.package === declaration.package) ||
      (plugin.provider === undefined &&
        (declaration === undefined || plugin.package === undefined)))
      ? [
          {
            ...(plugin.provider === undefined ? {} : { provider: plugin.provider }),
            ...(plugin.package === undefined ? {} : { package: plugin.package }),
            code: plugin.error.code,
            ...(plugin.error.reason === undefined ? {} : { reason: plugin.error.reason }),
            message: plugin.error.message,
          },
        ]
      : [],
  );
  const details = {
    reason: PROVIDER_RUNTIME_REASONS.notRegistered.reason,
    provider,
    registeredProviders: [...registeredProviders],
  };
  if (declaration && failures.length === 0) {
    const { hint, installCommand } = pluginInstallationHint(declaration, readVersion());
    return new AppError(
      'UNSUPPORTED_OPERATION',
      `${declaration.label} requires the ${declaration.package} plugin in this daemon runtime.`,
      {
        ...details,
        package: declaration.package,
        installCommand,
        hint: `On the daemon host:\n${hint} For an embedded host, call the plugin factory and pass its result in plugins when you recreate the runtime.`,
      },
    );
  }
  if (route === 'catalog') return undefined;
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `Provider "${provider}" is not available in this daemon runtime.`,
    {
      ...details,
      ...(failures.length > 0 ? { failedPlugins: failures } : {}),
      hint:
        failures.length > 0
          ? `Fix the plugin that failed to register (see failedPlugins or agent-device daemon status), restart the daemon, then retry lease allocation.`
          : `Restart the daemon with ${provider} configured, then retry lease allocation.`,
    },
  );
}

export function enrichProviderCatalogError(
  error: DaemonError,
  registeredProviders: readonly string[] | undefined,
  pluginInventory: readonly PluginInventoryEntry[] | undefined,
): DaemonError {
  if (error.details?.reason !== PROVIDER_INVENTORY_REASONS.instanceUnallocated.reason) return error;
  const provider = readLeaseProvider(error.details.leaseProvider);
  if (provider === undefined) return error;
  const missing = providerRuntimeAdmissionError(
    provider,
    'catalog',
    registeredProviders,
    pluginInventory,
  );
  if (!missing) return error;
  const { code, message, hint, details } = normalizeError(missing);
  return { ...error, code, message, hint, details: { ...error.details, ...details } };
}
