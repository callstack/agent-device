import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Lease, LeaseDevice, LeaseDeviceSpec } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import {
  connectionWorkspace,
  createTestClient,
  type LeaseAllocateRequest,
  type LeaseReleaseRequest,
  seedConnectionState,
  unexpectedCommandCall,
} from '../../../__tests__/remote-connection.fixtures.ts';

vi.mock('@agent-device/react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/react-native')>()),
  stopMetroTunnel: vi.fn(),
}));

import { materializeRemoteConnectionForCommand } from '../connection-runtime.ts';
import {
  readActiveConnectionState,
  readRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { connectCommand } from '../../../__tests__/test-utils/host-bound-commands.ts';
import { withCapturedStdoutAsync } from '../../../__tests__/test-utils/stream-capture.ts';

bindTestCommandHost();

const GRANTED_DEVICE: LeaseDevice = {
  model: 'iPhone 17 Pro',
  osVersion: '26.1',
  physical: false,
};

function proxyWorkspace(
  prefix: string,
  seed: {
    leaseId?: string;
    deviceKey?: string;
    leaseDeviceSpec?: { leaseId: string; spec: LeaseDeviceSpec; device?: LeaseDevice };
  } = {},
) {
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
      ...(seed.leaseDeviceSpec ? { leaseDeviceSpec: seed.leaseDeviceSpec } : {}),
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
    deviceKey: 'ios:mobile:SIM-REMOTE',
    ...extra,
  };
}

function renewingClient(heartbeats: string[]) {
  return createTestClient({
    listDevices: unexpectedCommandCall,
    allocate: unexpectedCommandCall,
    release: unexpectedCommandCall,
    heartbeat: async (request) => {
      heartbeats.push(request.leaseId);
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

test('proxy open by device spec sends the spec on allocate without listing devices and reports the granted device', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-device-spec-');
  const requests: LeaseAllocateRequest[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    host: createTestHostEnvironment(),
    command: 'open',
    flags: { ...flags, device: 'iPhone 17 Pro', osVersion: '>=26', physical: true },
    client: createTestClient({
      listDevices: unexpectedCommandCall,
      allocate: async (request) => {
        requests.push(request);
        return grantedLease(request, { device: GRANTED_DEVICE });
      },
      release: unexpectedCommandCall,
    }),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.deviceKey, undefined);
  assert.equal(requests[0]?.platform, 'ios');
  assert.equal(requests[0]?.device, 'iPhone 17 Pro');
  assert.equal(requests[0]?.osVersion, '>=26');
  assert.equal(requests[0]?.physical, true);
  assert.equal(requests[0]?.imageTag, undefined);
  assert.deepEqual(materialized.leaseDevice, GRANTED_DEVICE);
  // The leased device is named by its identity from here on; the spec does not reach the command.
  assert.equal(materialized.flags.udid, 'SIM-REMOTE');
  assert.equal(materialized.flags.osVersion, undefined);
  assert.equal(materialized.flags.physical, undefined);
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, 'lease-1');
  assert.deepEqual(state?.leaseDeviceSpec, {
    leaseId: 'lease-1',
    spec: { osVersion: '>=26', physical: true },
    device: GRANTED_DEVICE,
  });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a lease returned without lease.device for a spec request is released and the command fails with device-spec-unsupported', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-device-spec-noecho-');
  const releases: LeaseReleaseRequest[] = [];

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'open',
      flags: { ...flags, osVersion: '34', imageTag: 'google_apis_playstore' },
      client: createTestClient({
        listDevices: unexpectedCommandCall,
        allocate: async (request) => grantedLease(request),
        release: async (request) => {
          releases.push(request);
          return { released: true };
        },
      }),
    }),
    (error: AppError) =>
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.reason === 'device-spec-unsupported' &&
      JSON.stringify(error.details?.keys) === '["osVersion","imageTag"]' &&
      error.details?.leaseId === 'lease-1' &&
      error.details?.released === true,
  );
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.leaseId, 'lease-1');
  assert.equal(releases[0]?.deviceKey, 'ios:mobile:SIM-REMOTE');
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a failed release of an unconfirmed spec lease still fails the command with device-spec-unsupported', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace(
    'agent-device-proxy-device-spec-release-fails-',
  );

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'open',
      flags: { ...flags, physical: true },
      client: createTestClient({
        listDevices: unexpectedCommandCall,
        allocate: async (request) => grantedLease(request),
        release: async () => {
          throw new AppError('COMMAND_FAILED', 'backend unreachable');
        },
      }),
    }),
    (error: AppError) =>
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.reason === 'device-spec-unsupported' &&
      error.details?.released === false &&
      error.details?.leaseId === 'lease-1',
  );
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a later open on a live spec lease is served when it names the same spec', async () => {
  const { tempRoot, flags } = proxyWorkspace('agent-device-proxy-device-spec-same-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
    leaseDeviceSpec: { leaseId: 'lease-1', spec: { osVersion: '>=26' }, device: GRANTED_DEVICE },
  });
  const heartbeats: string[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    host: createTestHostEnvironment(),
    command: 'open',
    flags: { ...flags, osVersion: '>=26' },
    client: renewingClient(heartbeats),
  });

  assert.deepEqual(heartbeats, ['lease-1']);
  assert.equal(materialized.flags.udid, 'SIM-REMOTE');
  assert.equal(materialized.flags.osVersion, undefined);
  assert.deepEqual(materialized.leaseDevice, GRANTED_DEVICE);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a later open naming a different --os on a live spec lease is refused with CONNECTION_DEVICE_CONFLICT', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-device-spec-conflict-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
    leaseDeviceSpec: { leaseId: 'lease-1', spec: { osVersion: '>=26' } },
  });

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'open',
      flags: { ...flags, osVersion: '18.6.2' },
      client: renewingClient([]),
    }),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'CONNECTION_DEVICE_CONFLICT' &&
      JSON.stringify(error.details?.keys) === '["osVersion"]' &&
      error.details?.deviceKey === 'ios:mobile:SIM-REMOTE',
  );
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, 'lease-1');
  assert.deepEqual(state?.leaseDeviceSpec?.spec, { osVersion: '>=26' });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a spec named on a live lease allocated without one is refused with CONNECTION_DEVICE_CONFLICT', async () => {
  const { tempRoot, flags } = proxyWorkspace('agent-device-proxy-device-spec-unspecced-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
  });

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'install',
      flags: { ...flags, physical: true },
      client: renewingClient([]),
    }),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'CONNECTION_DEVICE_CONFLICT' &&
      JSON.stringify(error.details?.keys) === '["physical"]',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a later open naming another --udid beside the spec on a live spec lease is refused', async () => {
  const { tempRoot, flags } = proxyWorkspace('agent-device-proxy-device-spec-udid-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
    leaseDeviceSpec: { leaseId: 'lease-1', spec: { osVersion: '>=26' } },
  });

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'open',
      flags: { ...flags, osVersion: '>=26', udid: 'SIM-OTHER' },
      client: renewingClient([]),
    }),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'CONNECTION_DEVICE_CONFLICT' &&
      error.details?.requestedDevice === 'SIM-OTHER' &&
      error.details?.deviceKey === 'ios:mobile:SIM-REMOTE',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a new spec lease for another device than the requested --udid is released and refused', async () => {
  const { tempRoot, stateDir, flags } = proxyWorkspace('agent-device-proxy-device-spec-udid-new-');
  const releases: LeaseReleaseRequest[] = [];

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'open',
      flags: { ...flags, osVersion: '>=26', udid: 'SIM-OTHER' },
      client: createTestClient({
        listDevices: unexpectedCommandCall,
        allocate: async (request) => grantedLease(request, { device: GRANTED_DEVICE }),
        release: async (request) => {
          releases.push(request);
          return { released: true };
        },
      }),
    }),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'CONNECTION_DEVICE_CONFLICT' &&
      error.details?.requestedDevice === 'SIM-OTHER',
  );
  assert.deepEqual(
    releases.map((release) => release.leaseId),
    ['lease-1'],
  );
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a lease re-allocated by its stored device for a non-allocating command does not carry the spec', async () => {
  const { tempRoot, flags } = proxyWorkspace('agent-device-proxy-device-spec-snapshot-', {
    leaseId: 'lease-1',
    deviceKey: 'ios:mobile:SIM-REMOTE',
    leaseDeviceSpec: { leaseId: 'lease-1', spec: { osVersion: '>=26' }, device: GRANTED_DEVICE },
  });
  const requests: LeaseAllocateRequest[] = [];

  await materializeRemoteConnectionForCommand({
    host: createTestHostEnvironment(),
    command: 'snapshot',
    flags: { ...flags, osVersion: '>=26' },
    client: createTestClient({
      listDevices: unexpectedCommandCall,
      heartbeat: async () => {
        throw new AppError('UNAUTHORIZED', 'lease expired', { reason: 'LEASE_EXPIRED' });
      },
      allocate: async (request) => {
        requests.push(request);
        return grantedLease(request, { leaseId: 'lease-2' });
      },
    }),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.deviceKey, 'ios:mobile:SIM-REMOTE');
  assert.equal(requests[0]?.osVersion, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a spec recorded for an earlier lease neither serves nor describes the lease held now', async () => {
  // lease-1 was allocated by spec and has ended; lease-2 was then allocated by --udid without one.
  const { tempRoot, flags } = proxyWorkspace('agent-device-proxy-device-spec-stale-', {
    leaseId: 'lease-2',
    deviceKey: 'ios:mobile:SIM-REMOTE',
    leaseDeviceSpec: { leaseId: 'lease-1', spec: { osVersion: '>=26' }, device: GRANTED_DEVICE },
  });

  const materialized = await materializeRemoteConnectionForCommand({
    host: createTestHostEnvironment(),
    command: 'open',
    flags,
    client: renewingClient([]),
  });
  assert.equal(materialized.leaseDevice, undefined);

  await assert.rejects(
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'open',
      flags: { ...flags, osVersion: '>=26' },
      client: renewingClient([]),
    }),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' && error.details?.reason === 'CONNECTION_DEVICE_CONFLICT',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect proxy stores the device spec as profile defaults like platform and device', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-proxy-spec-');

  await withCapturedStdoutAsync(async () => {
    await connectCommand({
      positionals: ['proxy'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        daemonBaseUrl: 'http://proxy.example.test/agent-device',
        platform: 'android',
        osVersion: '34',
        imageTag: 'google_apis_playstore',
        physical: true,
      },
      client: createTestClient(),
    });
  });

  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  const generated = JSON.parse(fs.readFileSync(state.remoteConfigPath, 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(generated.platform, 'android');
  assert.equal(generated.osVersion, '34');
  assert.equal(generated.imageTag, 'google_apis_playstore');
  assert.equal(generated.physical, true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
