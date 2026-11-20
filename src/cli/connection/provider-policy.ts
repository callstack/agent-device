import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import {
  pluginConnectionInventory,
  pluginConnectionCapabilities,
  pluginLoadFailures,
  pluginConnectionNames,
  primePluginConnections,
} from '@agent-device/plugins/connection';
import { PLUGIN_INSTALLATION_REASONS, pluginInstallationHint } from '@agent-device/contracts/plugin-installation';
import { readVersion } from '@agent-device/host-kit/version';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import {
  getProviderPluginDeclaration,
  providerPluginRepairCommand,
} from '../../commands/provider-plugin-catalog.ts';
import {
  BUILTIN_CONNECT_PROVIDER_IDS,
  BUILTIN_PROVIDER_IDS,
  builtinConnectionCapabilities,
} from '../../builtin-provider-ids.ts';

export type ConnectProvider = string;

function remoteDaemonConnection(
  leaseKind: 'proxy' | 'remote-provider',
): ConnectionProviderCapabilities {
  return {
    leaseKind,
    forgetsEndedConnectionLease: leaseKind === 'proxy',
    requiresAppAttachment: false,
    requiresRemoteDaemon: true,
    supportsArtifacts: false,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: false,
  };
}

/**
 * Loads the plugin store before the first synchronous capability lookup for a provider that is not
 * built in, because a v2 plugin declares its capabilities in code, not in its manifest.
 */
export async function primeProviderConnection(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (provider === undefined || BUILTIN_CONNECT_PROVIDER_IDS.includes(provider)) return;
  await primePluginConnections(env, BUILTIN_PROVIDER_IDS);
  if (pluginConnectionCapabilities(provider, env) !== undefined) return;
  const unavailable = unavailableConnectPluginError(provider, env);
  if (unavailable) throw unavailable;
}

export function isConnectProviderName(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): value is ConnectProvider {
  return (
    value !== undefined &&
    (BUILTIN_CONNECT_PROVIDER_IDS.includes(value) ||
      pluginConnectionCapabilities(value, env) !== undefined)
  );
}

export function connectProviderNamesForError(env: NodeJS.ProcessEnv = process.env): string {
  const names = [...BUILTIN_CONNECT_PROVIDER_IDS, ...pluginConnectionNames(env)].join(', ');
  const failures = pluginLoadFailures(env).map(
    ({ package: name, provider, error }) =>
      `${name ?? provider ?? 'plugin store'}: ${error.message}`,
  );
  return failures.length === 0
    ? names
    : `${names}. Plugins that failed to load: ${failures.join('; ')}`;
}

// Why a connect provider cannot be served from the plugins this host has.
const CONNECTION_PLUGIN_REASONS = {
  // The provider's plugin is present but cannot serve the provider; `details.failedPlugins` names what broke.
  unavailable: { reason: 'plugin-unavailable' },
} as const satisfies ReasonTable<'connect'>;

export function unavailableConnectPluginError(
  provider: string,
  env: NodeJS.ProcessEnv,
): AppError | undefined {
  const declaration = getProviderPluginDeclaration(provider);
  if (!declaration) return undefined;
  const inventory = pluginConnectionInventory(env);
  const selected = inventory.find(
    (entry) => entry.package === declaration.package || entry.provider === provider,
  );
  const failures = pluginLoadFailures(env).filter(
    (entry) => entry === selected || entry.package === undefined,
  );
  if (selected || failures.length > 0) {
    return new AppError('UNSUPPORTED_OPERATION', `${declaration.label} plugin is unavailable.`, {
      reason: CONNECTION_PLUGIN_REASONS.unavailable.reason,
      provider,
      package: declaration.package,
      ...(failures.length > 0 ? { failedPlugins: failures } : {}),
      hint: `Run agent-device plugins list --json to inspect the plugin, fix its configuration or run ${providerPluginRepairCommand(declaration)}, then retry your original command.`,
    });
  }
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `${declaration.label} requires the ${declaration.package} plugin.`,
    {
      reason: PLUGIN_INSTALLATION_REASONS.notInstalled.reason,
      provider,
      package: declaration.package,
      ...pluginInstallationHint(declaration, readVersion()),
    },
  );
}

/** Bundled and installed providers declare their capabilities; the rest is the daemon's own routing. */
export function connectionProviderCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv,
): ConnectionProviderCapabilities {
  if (provider === 'proxy') return remoteDaemonConnection('proxy');
  const declared =
    builtinConnectionCapabilities(provider) ??
    (provider === undefined || provider === 'cloud'
      ? undefined
      : pluginConnectionCapabilities(provider, env));
  return declared ?? remoteDaemonConnection('remote-provider');
}
