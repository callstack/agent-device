import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import { readLeaseProvider } from '@agent-device/contracts/lease-scope';
import {
  pluginConnectionInventory,
  pluginConnectionCapabilities,
  pluginLoadFailures,
  pluginConnectionNames,
  primePluginConnections,
} from '@agent-device/plugins/connection';
import {
  PLUGIN_INSTALLATION_REASONS,
  pluginInstallationHint,
} from '@agent-device/contracts/plugin-installation';
import { readVersion } from '@agent-device/host-kit/version';
import { AppError } from '@agent-device/kernel/errors';
import {
  getProviderPluginDeclaration,
  providerPluginAdmission,
  providerPluginConnectionCapabilities,
} from '@agent-device/contracts/provider-plugin-catalog';
import { providerPluginRepairCommand } from '../../commands/provider-plugin-catalog.ts';
import { ROUTING_PROVIDER_IDENTITIES } from '@agent-device/plugins/contract';

export type ConnectProvider = string;

/**
 * What a route on a remote connection needs from the provider's plugin.
 *
 * `drives-connection`: this process drives the connection, so only a working local plugin can serve
 * it. `dispatches-to-remote-daemon`: the command sends its request to a configured remote daemon,
 * whose own provider registration answers for the provider here. `reads-connection-record`: the
 * route reads stored connection state and does neither.
 */
export type ProviderRoute =
  | 'drives-connection'
  | 'dispatches-to-remote-daemon'
  | 'reads-connection-record';

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
 * plugin declares its capabilities in code, not in its manifest. A provider this host has no working
 * plugin for refuses here: only the loaded plugin can drive a connection, and the catalog's copy of
 * its declaration is not a runtime.
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

/**
 * Whether a route admits `provider` itself before it authenticates or writes anything. The catalog
 * declares this per provider: `'provider'` means the core ships no runtime for it, so only its plugin
 * can supply it and a route that needs it here refuses it early. `'route'`, the default, keeps this
 * release's starting behavior: the connect handler admits a named provider, and the adapter that reads
 * a profile verifies the provider it names.
 */
export function requiresOwnProviderAdmission(provider: string | undefined): boolean {
  return providerPluginAdmission(readLeaseProvider(provider)) === 'provider';
}

/**
 * Loads the plugin store for a route on a remote connection, and refuses only where this host has to
 * supply the provider and cannot. A command that dispatches to a configured remote daemon is answered
 * by the daemon's own provider registration, so a plugin this host lacks is not that command's answer.
 * `connection status` reads a stored record and dispatches nothing: it needs no runtime here, only the
 * provider's declared capabilities, which its loaded plugin answers, or the plugin catalog's copy of
 * that declaration when the plugin is absent. Every other route is driven by this host, where only a
 * working plugin can serve it. All routes load the store when they can, so a connection keeps the
 * capabilities its provider declares.
 */
export async function admitProviderForRoute(
  provider: string | undefined,
  route: ProviderRoute,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (provider === undefined || ROUTING_PROVIDER_IDENTITIES.includes(provider)) return;
  await primePluginConnections(env);
  if (route === 'dispatches-to-remote-daemon') return;
  if (route === 'reads-connection-record' && declaredConnectionCapabilities(provider, env)) return;
  if (pluginConnectionCapabilities(provider, env) !== undefined) return;
  const unavailable = unavailableConnectPluginError(provider, env);
  if (unavailable) throw unavailable;
}

/**
 * The route a command on a remote connection takes: a configured daemon base URL answers there, and no
 * base URL means this process drives the connection. The daemon client reads the same two settings and
 * treats an empty base URL as none, so this does too, and the daemon URL of a stored record counts.
 */
export function providerRouteForConnection(options: {
  daemonBaseUrl: string | undefined;
  env: NodeJS.ProcessEnv;
}): ProviderRoute {
  return (options.daemonBaseUrl ?? options.env.AGENT_DEVICE_DAEMON_BASE_URL)
    ? 'dispatches-to-remote-daemon'
    : 'drives-connection';
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
      reason: PLUGIN_INSTALLATION_REASONS.unavailable,
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
      reason: PLUGIN_INSTALLATION_REASONS.notInstalled,
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
  return (
    pluginConnectionCapabilities(provider, env) ?? providerPluginConnectionCapabilities(provider)
  );
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
  return declared?.forgetsEndedConnectionLease === true;
}

/** Installed providers declare their capabilities; the rest is the daemon's own routing. */
export function connectionProviderCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv,
): ConnectionProviderCapabilities {
  return declaredConnectionCapabilities(provider, env) ?? remoteDaemonConnection('remote-provider');
}
