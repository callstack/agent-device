import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import {
  connectionWorkspace,
  seedConnectionState,
} from '../../__tests__/remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';

/** A connection `connect` recorded with checked RPC, holding one android lease. */
function checkedConnection() {
  const { stateDir, remoteConfigPath } = connectionWorkspace('agent-device-checked-lease-');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({ daemonBaseUrl: 'http://127.0.0.1:9', daemonRpc: 'checked' }),
  );
  seedConnectionState({
    stateDir,
    state: {
      session: 'checked',
      remoteConfigPath,
      tenant: 'tenant-a',
      runId: 'run-a',
      daemon: {
        baseUrl: 'http://127.0.0.1:9',
        transport: 'http',
        checkedRpcBaseUrl: 'http://127.0.0.1:9',
      },
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      platform: 'android',
    },
  });
  const heartbeats: unknown[] = [];
  const client = {
    leases: {
      heartbeat: async (request: { leaseId: string }) => {
        heartbeats.push(request);
        return {
          leaseId: request.leaseId,
          tenantId: 'tenant-a',
          runId: 'run-a',
          backend: 'android-instance',
        };
      },
    },
  } as unknown as AgentDeviceClient;
  const materialize = (command: string) =>
    materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command,
      client,
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        session: 'checked',
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'http://127.0.0.1:9',
        daemonRpc: 'checked',
        platform: 'android',
      },
    });
  return { materialize, heartbeats };
}

test('a command that renews its lease first goes health-first, fenced to the same daemon', async () => {
  const connection = checkedConnection();
  const materialized = await connection.materialize('snapshot');
  assert.equal(connection.heartbeats.length, 1);
  assert.equal(materialized.flags.daemonRpc, undefined);
});

test('a command that prepares no lease keeps checked RPC', async () => {
  const connection = checkedConnection();
  const materialized = await connection.materialize('session');
  assert.equal(connection.heartbeats.length, 0);
  assert.equal(materialized.flags.daemonRpc, 'checked');
});
