import {
  CLOUD_WEBDRIVER_PROVIDERS,
  isCloudWebDriverProviderName,
  type CloudWebDriverKnownProviderName,
} from '../../cloud-webdriver/providers.ts';

export type DirectDeviceConnectProvider = CloudWebDriverKnownProviderName | 'limrun';
export type ConnectProvider = 'cloud' | 'proxy' | DirectDeviceConnectProvider;

export function isConnectProviderName(value: string | undefined): value is ConnectProvider {
  return value === 'cloud' || value === 'proxy' || isDirectDeviceConnectProvider(value);
}

function isDirectDeviceConnectProvider(
  provider: string | undefined,
): provider is DirectDeviceConnectProvider {
  return provider === 'limrun' || isCloudWebDriverProviderName(provider);
}

export function isCloudWebDriverConnectProvider(
  provider: string | undefined,
): provider is CloudWebDriverKnownProviderName {
  return isCloudWebDriverProviderName(provider);
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

export function connectionProviderRequiresRemoteDaemon(provider: string | undefined): boolean {
  return !isDirectDeviceConnectProvider(provider);
}

export function connectionProviderLeaseKind(
  provider: string | undefined,
): 'proxy' | 'direct-device-provider' | 'remote-provider' {
  if (provider === 'proxy') return 'proxy';
  if (isDirectDeviceConnectProvider(provider)) return 'direct-device-provider';
  return 'remote-provider';
}
