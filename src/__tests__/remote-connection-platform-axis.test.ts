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
import { connectCommand } from '../cli/commands/connection.ts';
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
      error.details?.session === 'adc-proxy' &&
      error.details?.platform === 'ios',
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

// A connection opened with the `apple` family selector records that alias before any device is
// bound. Once a command resolves one specific device, the record must collapse to that device's
// leaf: keeping the alias would let a later command name the OTHER leaf of the same family —
// macOS against an iOS-bound lease — pass the scope guard, because family and leaf never
// conflict, and take the device's lease under a selector that names a different machine.
test('a connection opened on the apple family collapses to the bound device leaf', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-apple-family-',
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
      platform: 'apple',
      leaseBackend: 'ios-instance',
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
      {
        platform: 'macos',
        target: 'desktop',
        kind: 'device',
        id: 'MAC-1',
        name: 'Mac',
        booted: true,
        identifiers: {},
      },
    ],
    allocate: allocate.stub,
  });
  const install = (platform: 'apple' | 'ios' | 'macos') =>
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
        platform,
      },
      client,
    });

  const materialized = await install('ios');
  assert.equal(materialized.flags.leaseId, 'ios-lease-1');
  assert.equal(materialized.flags.udid, 'SIM-001');

  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.platform, 'ios');
  assert.equal(state?.deviceKey, 'ios:mobile:SIM-001');

  // macOS shares the `apple` family with the bound iOS simulator, so only the collapsed leaf
  // above — not the family alias — refuses this request before it touches the lease.
  await assert.rejects(
    async () => await install('macos'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.session === 'adc-proxy' &&
      error.details?.platform === 'ios',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// The same rule on the policies that never resolve a device themselves. A `connect --platform apple
// --lease-backend ios-instance` records the alias next to a backend that already rents only iOS
// devices, and this is the one command that turns it into a leaf: without the collapse the next
// `--platform macos` passed the guard, and its request went to the daemon as `apple` against the
// `ios-instance` lease instead of being refused here.
test('a default-policy connection collapses its recorded apple alias when the lease is bound', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-default-apple-binding-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-default',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-9',
      leaseBackend: 'ios-instance',
      platform: 'apple',
    },
  });
  const allocate = recordedLeaseAllocate({ leaseId: 'default-lease-1', backend: 'ios-instance' });
  const command = (platform: 'apple' | 'ios' | 'macos') =>
    materializeRemoteConnectionForCommand({
      command: 'snapshot',
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        tenant: 'acme',
        runId: 'run-9',
        session: 'adc-default',
        platform,
      },
      client: createTestClient({ allocate: allocate.stub }),
    });

  const materialized = await command('apple');
  assert.equal(materialized.flags.leaseId, 'default-lease-1');
  assert.equal(materialized.flags.platform, 'ios', 'the request names the leaf it leased on');
  assert.equal(allocate.request?.platform, 'ios', 'so does the allocate payload');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-default' })?.platform,
    'ios',
    'and so does the record the next command is guarded against',
  );

  await assert.rejects(
    async () => await command('macos'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.platform === 'ios',
    'a second leaf of the same family has to be refused, not retargeted',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// A state file written before the collapse existed records `apple` next to the backend that settled
// it, and a record that already matches its lease is never rewritten — so this connection stays as
// it was saved. The guard has to read the leaf that record owes, or the second leaf of the family
// still walks past it and the command goes out as `apple` on an `ios-instance` lease.
test('a stored apple record refuses the other leaf even though nothing rewrote it', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-apple-legacy-record-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-legacy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-9',
      leaseId: 'legacy-lease-1',
      leaseBackend: 'ios-instance',
      deviceKey: 'ios:mobile:SIM-001',
      platform: 'apple',
    },
  });
  const heartbeats: string[] = [];
  const command = (platform: 'macos') =>
    materializeRemoteConnectionForCommand({
      command: 'snapshot',
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        tenant: 'acme',
        runId: 'run-9',
        session: 'adc-legacy',
        platform,
      },
      client: createTestClient({
        heartbeat: async (request) => {
          heartbeats.push(request.leaseId);
          return {
            leaseId: request.leaseId,
            tenantId: 'acme',
            runId: 'run-9',
            backend: 'ios-instance',
          };
        },
      }),
    });

  await assert.rejects(
    async () => await command('macos'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.platform === 'ios',
  );
  assert.deepEqual(heartbeats, [], 'the lease was never touched by the refused request');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// `connect` asks the same question a command does — is this the connection already bound? — and it
// answers it before writing anything. A record saved as `apple` next to the `ios-instance` backend
// that decided it counted as compatible with `--platform macos`, because a family and a leaf never
// conflict, so the new selector was accepted onto the iOS device's connection with no `--force`.
test('connect refuses to reuse an apple-bound connection for the other leaf', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-apple-reuse-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-apple-reuse',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-9',
      leaseId: 'apple-lease-1',
      leaseBackend: 'ios-instance',
      platform: 'apple',
    },
  });
  const connect = (platform: 'apple' | 'ios' | 'macos') =>
    connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        tenant: 'acme',
        runId: 'run-9',
        session: 'adc-apple-reuse',
        platform,
        leaseBackend: 'ios-instance',
      },
      client: createTestClient(),
    });

  await assert.rejects(
    async () => await connect('macos'),
    /A different remote connection is already active/,
    "the other leaf of the family can't ride along on this lease",
  );
  await connect('ios');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-apple-reuse' })?.platform,
    'ios',
    'the leaf the backend rents is what the reconnected record carries',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
