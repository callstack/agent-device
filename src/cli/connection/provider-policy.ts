import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  isCloudWebDriverProviderName,
  type CloudWebDriverKnownProviderName,
} from '@agent-device/provider-webdriver/providers';
import { pluginConnectionCapabilities, pluginConnectionNames } from '../../plugins/connection.ts';

export type DirectDeviceConnectProvider = CloudWebDriverKnownProviderName | 'limrun';
import { RESERVED_PLUGIN_PROVIDERS as BUILTIN_CONNECT_PROVIDERS } from '../../plugins/manifest.ts';
export type BuiltinConnectProvider = (typeof BUILTIN_CONNECT_PROVIDERS)[number];
export type ConnectProvider = BuiltinConnectProvider | (string & {});

export function isConnectProviderName(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): value is ConnectProvider {
  return (
    value === 'cloud' ||
    value === 'proxy' ||
    isDirectDeviceConnectProvider(value) ||
    pluginConnectionCapabilities(value, env) !== undefined
  );
}

function isDirectDeviceConnectProvider(
  provider: string | undefined,
): provider is DirectDeviceConnectProvider {
  return provider === 'limrun' || isCloudWebDriverProviderName(provider);
}

export function connectProviderNamesForError(): string {
  return [...BUILTIN_CONNECT_PROVIDERS, ...pluginConnectionNames()].join(', ');
}

export function connectionProviderCapabilities(
  provider: string | undefined,
): ConnectionProviderCapabilities {
  const directDeviceProvider = isDirectDeviceConnectProvider(provider);
  const cloudWebDriver = isCloudWebDriverProviderName(provider);
  if (!directDeviceProvider && provider !== 'cloud' && provider !== 'proxy') {
    const plugin = pluginConnectionCapabilities(provider);
    if (plugin) return plugin;
  }
  return {
    leaseKind:
      provider === 'proxy'
        ? 'proxy'
        : directDeviceProvider
          ? 'direct-device-provider'
          : 'remote-provider',
    requiresAppAttachment: provider === CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    requiresRemoteDaemon: !directDeviceProvider,
    supportsArtifacts: cloudWebDriver,
    supportsDeferredAppSelection: provider === 'limrun',
    supportsDirectPortReverse: provider === 'limrun',
    usesCloudWebDriverLease: cloudWebDriver,
  };
}
