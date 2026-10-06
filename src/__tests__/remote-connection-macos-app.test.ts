import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { connectionWorkspace, createTestClient } from './remote-connection.fixtures.ts';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import { connectCommand, disconnectCommand } from '../cli/commands/connection.ts';
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

async function connectHostedMacosApp(
  workspace: { stateDir: string; remoteConfigPath: string },
  overrides: { leaseId?: string; force?: boolean } = {},
  release: AgentDeviceClient['leases']['release'] = async () => ({ released: true }),
): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await connectCommand({
      positionals: [],
      flags: {
        ...flagsFor(workspace.stateDir, workspace.remoteConfigPath),
        daemonBaseUrl: 'https://host.example/agent/',
        tenant: 'stim',
        runId: 'session-1',
        leaseId: LEASE_ID,
        leaseBackend: 'macos-app',
        platform: 'macos',
        ...overrides,
      },
      client: createTestClient({
        release,
        listDevices: async () => {
          throw new Error('a macos-app connection resolves no device into a new key');
        },
        allocate: async () => {
          throw new Error('a macos-app connection never allocates');
        },
      }),
    });
  } finally {
    stdout.mockRestore();
  }
}

test('connect binds the lease and device a macos-app remote config names, and open uses them', async () => {
  const workspace = connectionWorkspace('macos-app-connect-');
  writeHostIssuedConfig(workspace.remoteConfigPath);
  await connectHostedMacosApp(workspace);
  expect(
    readRemoteConnectionState({ stateDir: workspace.stateDir, session: 'hosted' }),
  ).toMatchObject({
    leaseId: LEASE_ID,
    leaseBackend: 'macos-app',
    deviceKey: 'com.example.app@4242',
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    positionals: ['com.example.app'],
    flags: { ...flagsFor(workspace.stateDir, workspace.remoteConfigPath), platform: 'macos' },
    client: createTestClient({
      allocate: async () => {
        throw new Error('a macos-app connection never allocates');
      },
    }),
  });
  expect(materialized.flags).toMatchObject({ leaseId: LEASE_ID, leaseBackend: 'macos-app' });
});

test('connect with an explicit --lease-id binds that lease over the one in the config', async () => {
  const workspace = connectionWorkspace('macos-app-connect-flag-');
  writeHostIssuedConfig(workspace.remoteConfigPath);
  const flagLeaseId = 'ffffffffffffffffffffffffffffffff';
  await connectHostedMacosApp(workspace, { leaseId: flagLeaseId });
  expect(
    readRemoteConnectionState({ stateDir: workspace.stateDir, session: 'hosted' }),
  ).toMatchObject({
    leaseId: flagLeaseId,
    deviceKey: 'com.example.app@4242',
  });
});

test('a forced reconnect keeps the host lease it binds again', async () => {
  const workspace = connectionWorkspace('macos-app-connect-force-');
  writeHostIssuedConfig(workspace.remoteConfigPath);
  await connectHostedMacosApp(workspace);
  const released: string[] = [];
  await connectHostedMacosApp(workspace, { force: true }, async (request) => {
    released.push(request.leaseId);
    return { released: true };
  });
  expect(released).toEqual([]);
  expect(
    readRemoteConnectionState({ stateDir: workspace.stateDir, session: 'hosted' }),
  ).toMatchObject({
    leaseId: LEASE_ID,
  });
});

test('a forced reconnect to a different host lease never releases the previous one', async () => {
  const workspace = connectionWorkspace('macos-app-connect-force-other-');
  writeHostIssuedConfig(workspace.remoteConfigPath);
  await connectHostedMacosApp(workspace);
  const released: string[] = [];
  await connectHostedMacosApp(
    workspace,
    { force: true, leaseId: 'ffffffffffffffffffffffffffffffff' },
    async (request) => {
      released.push(request.leaseId);
      return { released: true };
    },
  );
  expect(released).toEqual([]);
});

test('a reconnect without --force that names a different host lease is incompatible', async () => {
  const workspace = connectionWorkspace('macos-app-connect-other-lease-');
  writeHostIssuedConfig(workspace.remoteConfigPath);
  await connectHostedMacosApp(workspace);
  await expect(
    connectHostedMacosApp(workspace, { leaseId: 'ffffffffffffffffffffffffffffffff' }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(
    readRemoteConnectionState({ stateDir: workspace.stateDir, session: 'hosted' }),
  ).toMatchObject({ leaseId: LEASE_ID });
  await connectHostedMacosApp(workspace, { leaseId: LEASE_ID });
});

test('disconnect drops the local connection and never releases the host lease', async () => {
  const workspace = connectionWorkspace('macos-app-disconnect-');
  writeHostIssuedConfig(workspace.remoteConfigPath);
  await connectHostedMacosApp(workspace);
  const released: string[] = [];
  const closed: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await disconnectCommand({
      positionals: [],
      flags: flagsFor(workspace.stateDir, workspace.remoteConfigPath),
      client: createTestClient({
        closeSession: async (request) => {
          const session = request?.session ?? '';
          closed.push(session);
          return { session, identifiers: { session } };
        },
        release: async (request) => {
          released.push(request.leaseId);
          return { released: true };
        },
      }),
    });
  } finally {
    stdout.mockRestore();
  }
  expect(released).toEqual([]);
  expect(closed).toEqual(['hosted']);
  expect(readRemoteConnectionState({ stateDir: workspace.stateDir, session: 'hosted' })).toBeNull();
});
