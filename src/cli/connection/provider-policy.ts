import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import {
  pluginConnectionCapabilities,
  pluginLoadFailures,
  pluginConnectionNames,
  primePluginConnections,
} from '@agent-device/plugins/connection';
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

/** Bundled and installed providers declare their capabilities; the rest is the daemon's own routing. */
export function connectionProviderCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionProviderCapabilities {
  if (provider === 'proxy') return remoteDaemonConnection('proxy');
  const declared =
    builtinConnectionCapabilities(provider) ??
    (provider === 'cloud' ? undefined : pluginConnectionCapabilities(provider, env));
  return declared ?? remoteDaemonConnection('remote-provider');
}
