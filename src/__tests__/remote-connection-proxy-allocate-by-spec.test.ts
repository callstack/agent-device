import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Lease } from '@agent-device/contracts/client';
import type { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import {
  connectionWorkspace,
  createTestClient,
  type LeaseAllocateRequest,
  type LeaseReleaseRequest,
  seedConnectionState,
  unexpectedCommandCall,
} from './remote-connection.fixtures.ts';

vi.mock('@agent-device/react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/react-native')>()),
  stopMetroTunnel: vi.fn(),
}));

import { materializeRemoteConnectionForCommand } from '../cli/commands/connection-runtime.ts';
import { readRemoteConnectionState } from '../remote/remote-connection-state.ts';

const IPHONE_SIMULATOR = {
  platform: 'ios',
  target: 'mobile',
  kind: 'simulator',
  id: 'SIM-LOCAL',
  name: 'iPhone 17',
  booted: true,
  identifiers: { udid: 'SIM-LOCAL' },
  ios: { udid: 'SIM-LOCAL' },
} as const;

const LEASED_SIMULATOR = {
  ...IPHONE_SIMULATOR,
  id: 'SIM-REMOTE',
  identifiers: { udid: 'SIM-REMOTE' },
  ios: { udid: 'SIM-REMOTE' },
} as const;

type ListedDevices = Awaited<ReturnType<AgentDeviceClient['devices']['list']>>;

function proxyWorkspace(prefix: string, seed: { leaseId?: string; deviceKey?: string } = {}) {
  const workspace = connectionWorkspace(prefix);
  fs.writeFileSync(
    workspace.remoteConfigPath,
    JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }),
  );
  seedConnectionState({
    stateDir: workspace.stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath: workspace.remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      ...(seed.leaseId
        ? { leaseId: seed.leaseId, leaseBackend: 'ios-instance', platform: 'ios' }
        : {}),
      ...(seed.deviceKey ? { deviceKey: seed.deviceKey } : {}),
    },
  });
  const flags = {
    json: true,
    help: false,
    version: false,
    stateDir: workspace.stateDir,
    remoteConfig: workspace.remoteConfigPath,
    daemonBaseUrl: 'https://daemon.example',
    tenant: 'proxy',
    runId: 'proxy-client-1',
    session: 'adc-proxy',
    platform: 'ios',
  } as const;
  return { ...workspace, flags };
}

function grantedLease(request: LeaseAllocateRequest, extra: Partial<Lease> = {}): Lease {
  return {
    leaseId: 'lease-1',
    tenantId: request.tenant,
    runId: request.runId,
    backend: request.leaseBackend ?? 'ios-instance',
    leaseProvider: request.leaseProvider,
    clientId: request.clientId,
    deviceKey: request.deviceKey,
    ...extra,
  };
}

test('proxy open without an exact device allocates by its selectors and keeps the device the lease names', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-by-spec-');
  const requests: LeaseAllocateRequest[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: { ...flags, device: 'iPhone 17', target: 'mobile', iosSimulatorDeviceSet: '/sims' },
    client: createTestClient({
      // No device exists until the service behind the proxy allocates one.
      listDevices: unexpectedCommandCall,
      allocate: async (request) => {
        requests.push(request);
        return grantedLease(request, { deviceKey: 'ios:mobile:SIM-REMOTE' });
      },
    }),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.deviceKey, undefined);
  assert.equal(requests[0]?.platform, 'ios');
  assert.equal(requests[0]?.target, 'mobile');
  assert.equal(requests[0]?.device, 'iPhone 17');
  assert.equal(requests[0]?.iosSimulatorDeviceSet, '/sims');
  assert.equal(materialized.flags.udid, 'SIM-REMOTE');
  assert.equal(materialized.connection?.deviceKey, 'ios:mobile:SIM-REMOTE');
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.deviceKey, 'ios:mobile:SIM-REMOTE');
  assert.equal(state?.leaseId, 'lease-1');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function renewingClient(heartbeats: string[], devices: ListedDevices) {
  return createTestClient({
    listDevices: async () => devices,
    allocate: unexpectedCommandCall,
    heartbeat: async (request) => {
      heartbeats.push(request.deviceKey ?? '');
      return {
        leaseId: request.leaseId,
        tenantId: 'proxy',
        runId: 'proxy-client-1',
        backend: 'ios-instance',
        leaseProvider: 'proxy',
        clientId: 'client-1',
        deviceKey: 'ios:mobile:SIM-REMOTE',
      };
    },
  });
}

test('a later open on the live lease uses the device its key names instead of picking again', async () => {
  const { tempRoot, flags } = proxyWorkspace('agent-device-proxy-by-spec-renew-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
  });
  const heartbeats: string[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: { ...flags, device: 'iPhone 17' },
    // Another simulator with the same name must not replace the leased one.
    client: renewingClient(heartbeats, [IPHONE_SIMULATOR, LEASED_SIMULATOR]),
  });

  assert.deepEqual(heartbeats, ['ios:mobile:SIM-REMOTE']);
  assert.equal(materialized.flags.udid, 'SIM-REMOTE');
  assert.equal(materialized.connection?.deviceKey, 'ios:mobile:SIM-REMOTE');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a later open naming another device on the live lease is refused instead of running on the leased one', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-by-spec-conflict-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
  });

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      command: 'open',
      flags: { ...flags, device: 'iPhone 16' },
      client: renewingClient([], [LEASED_SIMULATOR, { ...IPHONE_SIMULATOR, name: 'iPhone 16' }]),
    }),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'CONNECTION_DEVICE_CONFLICT' &&
      error.details?.deviceKey === 'ios:mobile:SIM-REMOTE',
  );
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.deviceKey,
    'ios:mobile:SIM-REMOTE',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a later open scoped to a simulator set that excludes the leased device is refused', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-by-spec-scope-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
  });
  const listRequests: Array<string | undefined> = [];
  const client = createTestClient({
    listDevices: async (options = {}) => {
      listRequests.push(options.iosSimulatorDeviceSet);
      return options.iosSimulatorDeviceSet === '/leased-sims' ? [LEASED_SIMULATOR] : [];
    },
    allocate: unexpectedCommandCall,
    heartbeat: async (request) => ({
      leaseId: request.leaseId,
      tenantId: 'proxy',
      runId: 'proxy-client-1',
      backend: 'ios-instance',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      deviceKey: 'ios:mobile:SIM-REMOTE',
    }),
  });

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      command: 'open',
      flags: { ...flags, iosSimulatorDeviceSet: '/other-sims' },
      client,
    }),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'CONNECTION_DEVICE_CONFLICT' &&
      error.details?.deviceKey === 'ios:mobile:SIM-REMOTE',
  );
  assert.deepEqual(listRequests, ['/other-sims']);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.deviceKey,
    'ios:mobile:SIM-REMOTE',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a daemon whose lease names no device gets that lease released and the device picked locally', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-by-spec-old-');
  const requests: LeaseAllocateRequest[] = [];
  const releases: LeaseReleaseRequest[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: { ...flags, device: 'iPhone 17' },
    client: createTestClient({
      listDevices: async () => [IPHONE_SIMULATOR],
      allocate: async (request) => {
        requests.push(request);
        return grantedLease(request, { leaseId: `lease-${requests.length}` });
      },
      release: async (request) => {
        releases.push(request);
        return { released: true };
      },
    }),
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.deviceKey, undefined);
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.leaseId, 'lease-1');
  assert.equal(releases[0]?.deviceKey, undefined);
  assert.equal(requests[1]?.deviceKey, 'ios:mobile:SIM-LOCAL');
  assert.equal(materialized.flags.leaseId, 'lease-2');
  assert.equal(materialized.flags.udid, 'SIM-LOCAL');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId, 'lease-2');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a renewed lease that names no device is refused and left to its owner', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-by-spec-keyless-', {
    leaseId: 'lease-1',
  });

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      command: 'open',
      flags: { ...flags, device: 'iPhone 17' },
      client: createTestClient({
        listDevices: async () => [IPHONE_SIMULATOR],
        allocate: unexpectedCommandCall,
        release: unexpectedCommandCall,
        heartbeat: async (request) => ({
          leaseId: request.leaseId,
          tenantId: 'proxy',
          runId: 'proxy-client-1',
          backend: 'ios-instance',
          leaseProvider: 'proxy',
          clientId: 'client-1',
        }),
      }),
    }),
    (error: AppError) =>
      error.code === 'UNAUTHORIZED' &&
      error.details?.reason === 'LEASE_SCOPE_MISMATCH' &&
      error.details?.leaseId === 'lease-1',
  );
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, 'lease-1');
  assert.equal(state?.deviceKey, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('proxy open with an exact udid still picks locally and allocates that device once', async () => {
  const { tempRoot, flags } = proxyWorkspace('agent-device-proxy-by-spec-exact-');
  const requests: LeaseAllocateRequest[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: { ...flags, udid: 'SIM-LOCAL' },
    client: createTestClient({
      listDevices: async () => [IPHONE_SIMULATOR],
      allocate: async (request) => {
        requests.push(request);
        return grantedLease(request);
      },
      release: unexpectedCommandCall,
    }),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.deviceKey, 'ios:mobile:SIM-LOCAL');
  assert.equal(requests[0]?.udid, 'SIM-LOCAL');
  assert.equal(materialized.flags.udid, 'SIM-LOCAL');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
