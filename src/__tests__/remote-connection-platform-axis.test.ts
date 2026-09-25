// The platform axis a remote connection is named on (#2962).
//
// A `DeviceInfo` carries the INTERNAL `apple` platform while everything a connection records or
// sends — `--platform`, the connection state, the proxy device key, the lease request — speaks the
// PUBLIC leaf (`ios`/`macos`, ADR 0009). Comparing the two axes by string equality refused every
// iOS install and open on a proxy lease and demanded `connect --force` for a connection that had
// not changed. These pin both directions: the family and leaf selectors name the same devices, and
// a genuinely different platform is still refused.
//
// Kept out of `remote-connection.test.ts`, which is already over the test-file size tripwire and
// may not grow (docs/agents/testing.md).

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  connectionWorkspace,
  createTestClient,
  recordedLeaseAllocate,
  seedConnectionState,
} from './remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from '../cli/commands/connection-runtime.ts';
import { AppError } from '@agent-device/kernel/errors';
import { readRemoteConnectionState } from '../remote/remote-connection-state.ts';

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('proxy install against an iOS-bound connection is not refused as a platform change', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-ios-bound-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      platform: 'ios',
      leaseBackend: 'ios-instance',
    },
  });
  const allocate = recordedLeaseAllocate({ leaseId: 'ios-lease-1', backend: 'ios-instance' });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'install',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'proxy',
      runId: 'proxy-client-1',
      session: 'adc-proxy',
      platform: 'ios',
    },
    client: createTestClient({
      listDevices: async () => [
        {
          platform: 'ios',
          target: 'mobile',
          kind: 'simulator',
          id: 'SIM-001',
          name: 'iPhone 16',
          booted: true,
          identifiers: { udid: 'SIM-001' },
          ios: { udid: 'SIM-001' },
        },
      ],
      allocate: allocate.stub,
    }),
  });

  assert.equal(materialized.flags.leaseId, 'ios-lease-1');
  assert.equal(allocate.request?.deviceKey, 'ios:mobile:SIM-001');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// The connection records a leaf; `--platform apple` names the same devices. Comparing the two by
// string equality refused the request and demanded `connect --force` for a connection that had not
// changed at all (#2962).
test('proxy install with the apple family selector matches an ios-bound connection', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-apple-selector-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      platform: 'ios',
      leaseBackend: 'ios-instance',
    },
  });
  const allocate = recordedLeaseAllocate({ leaseId: 'ios-lease-1', backend: 'ios-instance' });

  await materializeRemoteConnectionForCommand({
    command: 'install',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'proxy',
      runId: 'proxy-client-1',
      session: 'adc-proxy',
      platform: 'apple',
    },
    client: createTestClient({
      listDevices: async () => [
        {
          platform: 'ios',
          target: 'mobile',
          kind: 'simulator',
          id: 'SIM-001',
          name: 'iPhone 16',
          booted: true,
          identifiers: { udid: 'SIM-001' },
          ios: { udid: 'SIM-001' },
        },
      ],
      allocate: allocate.stub,
    }),
  });

  assert.equal(allocate.request?.deviceKey, 'ios:mobile:SIM-001');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// The comparison itself, without a device resolution in the way: the connection bound `ios` from
// `connect`, and `--platform apple` names those same devices. String inequality refused the command
// and told the user to reconnect (#2962), while `apple` versus a non-Apple platform must still
// refuse.
test('remote command with the apple family selector matches an ios-bound connection', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-apple-selector-scope-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-apple',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'apple-lease-1',
      leaseBackend: 'ios-instance',
      platform: 'ios',
    },
  });
  const heartbeats: string[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'snapshot',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-apple',
      platform: 'apple',
    },
    client: createTestClient({
      heartbeat: async (request) => {
        heartbeats.push(request.leaseId);
        return {
          leaseId: request.leaseId,
          tenantId: 'acme',
          runId: 'run-123',
          backend: 'ios-instance',
        };
      },
    }),
  });

  assert.deepEqual(heartbeats, ['apple-lease-1']);
  assert.equal(materialized.flags.leaseId, 'apple-lease-1');
  assert.equal(materialized.flags.platform, 'ios');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('proxy install against a differently-bound platform is still refused', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-platform-conflict-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      platform: 'ios',
      leaseBackend: 'ios-instance',
    },
  });

  await assert.rejects(
    async () =>
      await materializeRemoteConnectionForCommand({
        command: 'install',
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://daemon.example',
          tenant: 'proxy',
          runId: 'proxy-client-1',
          session: 'adc-proxy',
          platform: 'android',
        },
        client: createTestClient(),
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /different platform/.test(error.message),
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// The resolved device's internal platform is the collapsed `apple`, while the lease request, the
// connection state, and `--platform` all speak the public leaf `ios`. Writing the internal value
// into the connection state is what #2962 reported: it refused the next command of the same
// session, whose bound platform was read back out of that state.
test('proxy install records the public platform and the next command reuses that scope', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-ios-install-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
    },
  });
  const allocate = recordedLeaseAllocate({ leaseId: 'ios-lease-1', backend: 'ios-instance' });
  const client = createTestClient({
    listDevices: async () => [
      {
        platform: 'ios',
        target: 'mobile',
        kind: 'simulator',
        id: 'SIM-001',
        name: 'iPhone 16',
        booted: true,
        identifiers: { udid: 'SIM-001' },
        ios: { udid: 'SIM-001' },
      },
    ],
    allocate: allocate.stub,
  });
  const install = () =>
    materializeRemoteConnectionForCommand({
      command: 'install',
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        tenant: 'proxy',
        runId: 'proxy-client-1',
        session: 'adc-proxy',
        platform: 'ios',
      },
      client,
    });

  const materialized = await install();
  assert.equal(materialized.flags.leaseId, 'ios-lease-1');
  assert.equal(materialized.flags.platform, 'ios');
  assert.equal(materialized.flags.udid, 'SIM-001');
  assert.equal(allocate.request?.platform, 'ios');
  assert.equal(allocate.request?.deviceKey, 'ios:mobile:SIM-001');

  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.platform, 'ios');
  assert.equal(state?.deviceKey, 'ios:mobile:SIM-001');

  // The second command reads its bound platform back out of that state.
  const reused = await install();
  assert.equal(reused.flags.platform, 'ios');
  assert.equal(reused.flags.leaseId, 'ios-lease-1');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
