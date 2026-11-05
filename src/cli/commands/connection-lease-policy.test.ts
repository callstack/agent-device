import { expect, test, vi } from 'vitest';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { REMOTE_LEASE_IDLE_TTL_MS } from '@agent-device/contracts/lease-scope';
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
  proxy: { ...LOCAL_PROVIDER, leaseKind: 'proxy', requiresRemoteDaemon: true },
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

test.each([
  ['proxy', REMOTE_LEASE_IDLE_TTL_MS],
  ['cloud-device', REMOTE_LEASE_IDLE_TTL_MS],
  ['cloud-device-deferred', REMOTE_LEASE_IDLE_TTL_MS],
  ['cloud-webdriver', REMOTE_LEASE_IDLE_TTL_MS],
  ['local-device', undefined],
  ['malformed-flag', undefined],
])('a %s lease requests TTL %s', (provider, expected) => {
  expect(ttlFor(provider)).toBe(expected);
});
