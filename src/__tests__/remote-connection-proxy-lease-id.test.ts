import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import {
  connectionWorkspace,
  createTestClient,
  type LeaseAllocateRequest,
  seedConnectionState,
} from './remote-connection.fixtures.ts';

vi.mock('@agent-device/react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/react-native')>()),
  stopMetroTunnel: vi.fn(),
}));

import { materializeRemoteConnectionForCommand } from '../cli/commands/connection-runtime.ts';
import { readRemoteConnectionState } from '../remote/remote-connection-state.ts';

const DAEMON_LEASE_ID = 'abc123abc123abc1';

const LEASED_DEVICE = {
  android: { backend: 'android-instance', deviceKey: 'android:mobile:emulator-5554' },
  ios: { backend: 'ios-instance', deviceKey: 'ios:mobile:SIM-1' },
} as const;

function recordingAllocate(requests: LeaseAllocateRequest[]) {
  return async (request: LeaseAllocateRequest) => {
    requests.push(request);
    const leased = LEASED_DEVICE[request.platform === 'ios' ? 'ios' : 'android'];
    // The daemon's own id, as an older daemon that ignores the requested one answers.
    return {
      leaseId: DAEMON_LEASE_ID,
      tenantId: request.tenant,
      runId: request.runId,
      backend: request.leaseBackend ?? leased.backend,
      leaseProvider: request.leaseProvider,
      clientId: request.clientId,
      deviceKey: request.deviceKey ?? leased.deviceKey,
    };
  };
}

test('proxy allocation sends a fresh lease id on every attempt and keeps the id the daemon returns', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-proxy-lease-id-',
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
  const requests: LeaseAllocateRequest[] = [];
  const client = createTestClient({
    allocate: recordingAllocate(requests),
    heartbeat: async () => {
      throw new AppError('UNAUTHORIZED', 'Lease expired', { reason: 'LEASE_EXPIRED' });
    },
  });
  const flags = {
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
  } as const;

  const first = await materializeRemoteConnectionForCommand({
    command: 'install',
    flags: { ...flags },
    client,
  });
  const second = await materializeRemoteConnectionForCommand({
    command: 'install',
    flags: { ...flags },
    client,
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0]?.leaseId ?? '', /^[0-9a-f]{32}$/);
  assert.match(requests[1]?.leaseId ?? '', /^[0-9a-f]{32}$/);
  assert.notEqual(requests[0]?.leaseId, requests[1]?.leaseId);
  assert.equal(first.flags.leaseId, DAEMON_LEASE_ID);
  assert.equal(second.flags.leaseId, DAEMON_LEASE_ID);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId,
    DAEMON_LEASE_ID,
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a non-proxy remote connection leaves the lease id to the daemon', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-cloud-lease-id-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-cloud',
      remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseProvider: 'aws-device-farm',
      platform: 'ios',
    },
  });
  const requests: LeaseAllocateRequest[] = [];

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'screenshot',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-cloud',
      platform: 'ios',
    },
    client: createTestClient({ allocate: recordingAllocate(requests) }),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.leaseId, undefined);
  assert.equal(materialized.flags.leaseId, DAEMON_LEASE_ID);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
