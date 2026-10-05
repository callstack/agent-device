import { expect, test } from 'vitest';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { connectionWorkspace, createTestClient } from './remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from '../cli/commands/connection-runtime.ts';
import { readRemoteConnectionState } from '../remote/remote-connection-state.ts';
import { LeaseRegistry } from '../daemon/lease-registry.ts';

const LEASE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function writeHostIssuedConfig(remoteConfigPath: string): void {
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://host.example/agent/',
      daemonAuthToken: 'client-token',
      tenant: 'stim',
      runId: 'session-1',
      leaseId: LEASE_ID,
      leaseBackend: 'macos-app',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      deviceKey: 'com.example.app@4242',
      platform: 'macos',
    }),
  );
}

function flagsFor(stateDir: string, remoteConfig: string) {
  return {
    json: true,
    help: false,
    version: false,
    stateDir,
    remoteConfig,
    session: 'hosted',
  };
}

test('a macos-app remote config opens on the lease the host allocated, unchanged', async () => {
  const { stateDir, remoteConfigPath } = connectionWorkspace('macos-app-open-');
  writeHostIssuedConfig(remoteConfigPath);
  const registry = new LeaseRegistry();
  registry.putHostLease(LEASE_ID, {
    tenantId: 'stim',
    runId: 'session-1',
    clientId: 'client-1',
    leaseBackend: 'macos-app',
    leaseProvider: 'proxy',
    deviceKey: 'com.example.app@4242',
  });
  const client = createTestClient({
    listDevices: async () => {
      throw new Error('a macos-app connection resolves no device into a new key');
    },
    allocate: async () => {
      throw new Error('a macos-app connection never allocates');
    },
    heartbeat: async (request) => registry.heartbeatLease({ ...request, tenantId: request.tenant }),
  });
  const flags = flagsFor(stateDir, remoteConfigPath);
  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    positionals: ['com.example.app'],
    flags,
    client,
  });
  expect(materialized.flags).toMatchObject({
    leaseId: LEASE_ID,
    leaseBackend: 'macos-app',
    platform: 'macos',
  });
  expect(materialized.connection).toMatchObject({ deviceKey: 'com.example.app@4242' });
  expect(readRemoteConnectionState({ stateDir, session: 'hosted' })).toMatchObject({
    leaseId: LEASE_ID,
    deviceKey: 'com.example.app@4242',
  });
});

test('an inactive host lease is reported, never replaced by a tenant allocation', async () => {
  const { stateDir, remoteConfigPath } = connectionWorkspace('macos-app-inactive-');
  writeHostIssuedConfig(remoteConfigPath);
  let allocations = 0;
  const client = createTestClient({
    allocate: async () => {
      allocations += 1;
      throw new Error('unreachable');
    },
    heartbeat: async () => {
      throw new AppError('UNAUTHORIZED', 'Lease is not active', { reason: 'LEASE_NOT_FOUND' });
    },
  });
  await expect(
    materializeRemoteConnectionForCommand({
      command: 'snapshot',
      flags: flagsFor(stateDir, remoteConfigPath),
      client,
    }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED', details: { reason: 'LEASE_NOT_FOUND' } });
  expect(allocations).toBe(0);
});
