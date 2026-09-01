import {
  CLOUD_WEBDRIVER_PROVIDERS,
  isCloudWebDriverProviderName,
  type CloudWebDriverKnownProviderName,
} from '@agent-device/provider-webdriver';

export type DirectDeviceConnectProvider = CloudWebDriverKnownProviderName | 'limrun';
export type ConnectProvider = 'cloud' | 'proxy' | DirectDeviceConnectProvider;

export type ConnectionProviderCapabilities = {
  leaseKind: 'proxy' | 'direct-device-provider' | 'remote-provider';
  requiresAppAttachment: boolean;
  requiresRemoteDaemon: boolean;
  supportsArtifacts: boolean;
  supportsDeferredAppSelection: boolean;
  supportsDirectPortReverse: boolean;
  usesCloudWebDriverLease: boolean;
};

export function isConnectProviderName(value: string | undefined): value is ConnectProvider {
  return value === 'cloud' || value === 'proxy' || isDirectDeviceConnectProvider(value);
}

function isDirectDeviceConnectProvider(
  provider: string | undefined,
): provider is DirectDeviceConnectProvider {
  return provider === 'limrun' || isCloudWebDriverProviderName(provider);
}

export function connectProviderNamesForError(): string {
  return [
    'cloud',
    'proxy',
    CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    'limrun',
  ].join(', ');
}

export function connectionProviderCapabilities(
  provider: string | undefined,
): ConnectionProviderCapabilities {
  const directDeviceProvider = isDirectDeviceConnectProvider(provider);
  const cloudWebDriver = isCloudWebDriverProviderName(provider);
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
