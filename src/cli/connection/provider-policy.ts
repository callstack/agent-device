import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import { cloudWebDriverProviderDeclaration } from '@agent-device/provider-webdriver/providers';
import { pluginConnectionCapabilities, pluginConnectionNames } from '../../plugins/connection.ts';
import { RESERVED_PLUGIN_PROVIDERS as BUILTIN_CONNECT_PROVIDERS } from '../../plugins/manifest.ts';

export type BuiltinConnectProvider = (typeof BUILTIN_CONNECT_PROVIDERS)[number];
export type ConnectProvider = BuiltinConnectProvider | (string & {});

const LIMRUN_CONNECTION: ConnectionProviderCapabilities = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: false,
  supportsDeferredAppSelection: true,
  supportsDirectPortReverse: true,
  usesCloudWebDriverLease: false,
};

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

export function isConnectProviderName(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): value is ConnectProvider {
  return (
    value === 'cloud' ||
    value === 'proxy' ||
    value === 'limrun' ||
    cloudWebDriverProviderDeclaration(value) !== undefined ||
    pluginConnectionCapabilities(value, env) !== undefined
  );
}

export function connectProviderNamesForError(): string {
  return [...BUILTIN_CONNECT_PROVIDERS, ...pluginConnectionNames()].join(', ');
}

/** Bundled and installed providers declare their capabilities; the rest is the daemon's own routing. */
export function connectionProviderCapabilities(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionProviderCapabilities {
  if (provider === 'limrun') return LIMRUN_CONNECTION;
  if (provider === 'proxy') return remoteDaemonConnection('proxy');
  const declared =
    cloudWebDriverProviderDeclaration(provider)?.connection ??
    (provider === 'cloud' ? undefined : pluginConnectionCapabilities(provider, env));
  return declared ?? remoteDaemonConnection('remote-provider');
}
