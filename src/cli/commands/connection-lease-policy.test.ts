import { expect, test, vi } from 'vitest';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import { CLOUD_DEVICE_LEASE_TTL_MS } from '@agent-device/contracts/lease-scope';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { connectionLeasePolicyForState } from './connection-lease-policy.ts';

const LOCAL_PROVIDER: ConnectionProviderCapabilities = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: false,
  supportsDeferredAppSelection: false,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: false,
};

const providers: Record<string, ConnectionProviderCapabilities> = {
  'cloud-device': { ...LOCAL_PROVIDER, holdsCloudDevice: true },
  'cloud-device-deferred': {
    ...LOCAL_PROVIDER,
    supportsDeferredAppSelection: true,
    holdsCloudDevice: true,
  },
  'cloud-webdriver': { ...LOCAL_PROVIDER, usesCloudWebDriverLease: true },
  'local-device': LOCAL_PROVIDER,
  'malformed-flag': { ...LOCAL_PROVIDER, holdsCloudDevice: 'false' as never },
};

vi.mock('../connection/provider-policy.ts', () => ({
  connectionProviderCapabilities: (provider: string) => providers[provider],
}));

function ttlFor(leaseProvider: string): number | undefined {
  const state = { leaseProvider } as RemoteConnectionState;
  return connectionLeasePolicyForState(state).ttlMs(state);
}

test.each(['cloud-device', 'cloud-device-deferred', 'cloud-webdriver'])(
  'a %s lease uses the cloud device TTL',
  (provider) => {
    expect(ttlFor(provider)).toBe(CLOUD_DEVICE_LEASE_TTL_MS);
  },
);

test.each(['local-device', 'malformed-flag'])(
  'a %s lease keeps the daemon default TTL',
  (provider) => {
    expect(ttlFor(provider)).toBeUndefined();
  },
);
