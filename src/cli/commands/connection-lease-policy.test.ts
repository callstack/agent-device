import { expect, test } from 'vitest';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import {
  CLOUD_DEVICE_LEASE_TTL_MS,
  connectionLeasePolicyForState,
} from './connection-lease-policy.ts';

function stateFor(leaseProvider: string): RemoteConnectionState {
  return { leaseProvider } as RemoteConnectionState;
}

test.each(['limrun', 'aws-device-farm'])('a %s lease uses the cloud device TTL', (provider) => {
  const state = stateFor(provider);

  expect(connectionLeasePolicyForState(state).ttlMs(state)).toBe(CLOUD_DEVICE_LEASE_TTL_MS);
});

test('a lease for a provider without a cloud device keeps the daemon default TTL', () => {
  const state = stateFor('webos');

  expect(connectionLeasePolicyForState(state).ttlMs(state)).toBeUndefined();
});
