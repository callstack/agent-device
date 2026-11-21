import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import {
  pluginConnectionInventory,
  pluginConnectionCapabilities,
  pluginLoadFailures,
  pluginConnectionNames,
  primePluginConnections,
} from '@agent-device/plugins/connection';
import { pluginInstallationHint } from '@agent-device/contracts/plugin-installation';
import { readVersion } from '@agent-device/host-kit/version';
import { AppError } from '@agent-device/kernel/errors';
import {
  getProviderPluginDeclaration,
  providerPluginRepairCommand,
} from '../../commands/provider-plugin-catalog.ts';
import { ROUTING_PROVIDER_IDENTITIES } from '@agent-device/plugins/contract';

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
 * The provider a command on a remote connection uses: the stored connection's, then the remote
 * config profile's. Admission and materialization both read it here, so they agree.
 */
export function connectionLeaseProvider(
  stored: { leaseProvider?: string } | null | undefined,
  profileLeaseProvider: string | undefined,
): string | undefined {
  return stored?.leaseProvider ?? profileLeaseProvider;
}

/**
 * Loads the plugin store before the first synchronous capability lookup for a provider, because a
 * plugin declares its capabilities in code, not in its manifest.
 */
export async function primeProviderConnection(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (provider === undefined || ROUTING_PROVIDER_IDENTITIES.includes(provider)) return;
  await primePluginConnections(env);
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
    (ROUTING_PROVIDER_IDENTITIES.includes(value) ||
      pluginConnectionCapabilities(value, env) !== undefined)
  );
}

export function connectProviderNamesForError(env: NodeJS.ProcessEnv = process.env): string {
  const names = [...ROUTING_PROVIDER_IDENTITIES, ...pluginConnectionNames(env)].join(', ');
  const failures = pluginLoadFailures(env).map(
    ({ package: name, provider, error }) =>
      `${name ?? provider ?? 'plugin store'}: ${error.message}`,
  );
  return failures.length === 0
    ? names
    : `${names}. Plugins that failed to load: ${failures.join('; ')}`;
}

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
      reason: 'plugin-unavailable',
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
      reason: 'plugin-not-installed',
      provider,
      package: declaration.package,
      ...pluginInstallationHint(declaration, readVersion()),
    },
  );
}

/**
 * The capabilities a provider declares: the daemon's own routing for `proxy`, `cloud` and no
 * provider, or a loaded plugin's declaration. Undefined when the provider's plugin is not loaded.
 */
function declaredConnectionCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv,
): ConnectionProviderCapabilities | undefined {
  if (provider === 'proxy') return remoteDaemonConnection('proxy');
  if (provider === undefined || provider === 'cloud')
    return remoteDaemonConnection('remote-provider');
  return pluginConnectionCapabilities(provider, env);
}

/**
 * Whether a provider forgets an ended connection lease, answered without loading any plugin: the
 * provider's own declaration when this process has it, then the plugin catalog's copy of it. A
 * provider that neither knows keeps its lease.
 */
export function providerForgetsEndedConnectionLease(
  provider: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const declared = declaredConnectionCapabilities(provider, env);
  if (declared) return declared.forgetsEndedConnectionLease === true;
  if (provider === undefined) return false;
  return getProviderPluginDeclaration(provider)?.forgetsEndedConnectionLease === true;
}

/** Installed providers declare their capabilities; the rest is the daemon's own routing. */
export function connectionProviderCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv,
): ConnectionProviderCapabilities {
  return declaredConnectionCapabilities(provider, env) ?? remoteDaemonConnection('remote-provider');
}
