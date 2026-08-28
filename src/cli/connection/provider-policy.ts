import {
  CLOUD_WEBDRIVER_PROVIDERS,
  isCloudWebDriverProviderName,
  type CloudWebDriverKnownProviderName,
} from '@agent-device/provider-webdriver';

export type DirectDeviceConnectProvider = CloudWebDriverKnownProviderName | 'limrun';
export type ConnectProvider = 'cloud' | 'proxy' | DirectDeviceConnectProvider;

type ConnectionProviderCapabilities = {
  leaseKind: 'proxy' | 'direct-device-provider' | 'remote-provider';
  requiresAppAttachment: boolean;
  requiresRemoteDaemon: boolean;
  supportsArtifacts: boolean;
  supportsDeferredAppSelection: boolean;
  supportsDirectPortReverse: boolean;
  usesCloudWebDriverLease: boolean;
};

const DEFERRED_APP_SELECTION_PROVIDERS = new Set<DirectDeviceConnectProvider>(['limrun']);

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

function connectionProviderRequiresRemoteDaemon(provider: string | undefined): boolean {
  return !isDirectDeviceConnectProvider(provider);
}

export function connectionProviderSupportsDeferredAppSelection(
  provider: string | undefined,
): boolean {
  return isDirectDeviceConnectProvider(provider) && DEFERRED_APP_SELECTION_PROVIDERS.has(provider);
}

export function connectionProviderRequiresAppAttachment(provider: string | undefined): boolean {
  return provider === CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm;
}

export function connectionProviderSupportsArtifacts(provider: string | undefined): boolean {
  return isCloudWebDriverProviderName(provider);
}

export function connectionProviderSupportsDirectPortReverse(provider: string | undefined): boolean {
  return provider === 'limrun';
}

export function connectionProviderUsesCloudWebDriverLease(provider: string | undefined): boolean {
  return isCloudWebDriverProviderName(provider);
}

function connectionProviderLeaseKind(
  provider: string | undefined,
): 'proxy' | 'direct-device-provider' | 'remote-provider' {
  if (provider === 'proxy') return 'proxy';
  if (isDirectDeviceConnectProvider(provider)) return 'direct-device-provider';
  return 'remote-provider';
}

export function connectionProviderCapabilitiesForLease(source: {
  leaseProvider?: string;
}): ConnectionProviderCapabilities {
  return connectionProviderCapabilities(source.leaseProvider);
}

export function connectionProviderCapabilitiesForVerification(
  verification: { provider?: string } | undefined,
): ConnectionProviderCapabilities {
  return connectionProviderCapabilities(verification?.provider);
}

function connectionProviderCapabilities(
  provider: string | undefined,
): ConnectionProviderCapabilities {
  return {
    leaseKind: connectionProviderLeaseKind(provider),
    requiresAppAttachment: connectionProviderRequiresAppAttachment(provider),
    requiresRemoteDaemon: connectionProviderRequiresRemoteDaemon(provider),
    supportsArtifacts: connectionProviderSupportsArtifacts(provider),
    supportsDeferredAppSelection: connectionProviderSupportsDeferredAppSelection(provider),
    supportsDirectPortReverse: connectionProviderSupportsDirectPortReverse(provider),
    usesCloudWebDriverLease: connectionProviderUsesCloudWebDriverLease(provider),
  };
}
