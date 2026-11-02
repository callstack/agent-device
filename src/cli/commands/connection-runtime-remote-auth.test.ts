import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { createAgentDeviceClient } from '@agent-device/client';
import { AppError } from '@agent-device/kernel/errors';
import { isInactiveLeaseError } from '@agent-device/contracts/lease-scope';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import {
  connectionWorkspace,
  seedConnectionState,
} from '../../__tests__/remote-connection.fixtures.ts';
import { startPublicDaemonRuntime } from '../../__tests__/test-utils/public-daemon-runtime.ts';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';

test('an authenticated remote rollback inherits routing and ends only the replacement of an inactive recorded lease', async () => {
  const daemon = await startPublicDaemonRuntime({ serverMode: 'http' });
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-authenticated-rollback-',
  );
  const host = createTestHostEnvironment();
  const config = {
    stateDir,
    daemonBaseUrl: daemon.baseUrl,
    daemonAuthToken: daemon.runtime.token,
    daemonTransport: 'http' as const,
    daemonServerMode: 'http' as const,
    tenant: 'route-tenant',
    runId: 'route-run',
    session: 'remote-auth',
  };
  const scope = {
    tenant: config.tenant,
    runId: config.runId,
    leaseBackend: 'android-instance' as const,
  };
  const client = createAgentDeviceClient(config, { host });
  try {
    const first = await client.leases.allocate(scope);
    fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: daemon.baseUrl }));
    seedConnectionState({
      stateDir,
      state: {
        session: config.session,
        remoteConfigPath,
        tenant: config.tenant,
        runId: config.runId,
        daemon: { baseUrl: daemon.baseUrl, transport: 'http', serverMode: 'http' },
        leaseId: first.leaseId,
        leaseBackend: 'android-instance',
        platform: 'android',
      },
    });
    await client.leases.release({ ...scope, leaseId: first.leaseId });
    await assert.rejects(
      client.leases.allocate({ ...scope, leaseId: first.leaseId }),
      (error: unknown) => error instanceof AppError && error.details?.reason === 'LEASE_ID_IN_USE',
    );
    const bound = createAgentDeviceClient({ ...config, leaseId: first.leaseId }, { host });
    const allocate = vi.spyOn(bound.leases, 'allocate');
    const release = vi.spyOn(bound.leases, 'release');
    const primary = new AppError('COMMAND_FAILED', 'Metro preparation failed', {
      reason: 'METRO_PREPARE_FAILED',
    });
    vi.spyOn(bound.metro, 'prepare').mockRejectedValue(primary);
    await assert.rejects(
      materializeRemoteConnectionForCommand({
        host,
        command: 'open',
        client: bound,
        flags: {
          ...config,
          json: true,
          help: false,
          version: false,
          remoteConfig: remoteConfigPath,
          platform: 'android',
          metroPublicBaseUrl: 'https://metro.example.test',
        },
      }),
      (error: unknown) => error === primary,
    );
    assert.equal(allocate.mock.results.length, 1);
    const replacement = await allocate.mock.results[0]!.value;
    assert.equal(replacement.created, true);
    assert.notEqual(replacement.leaseId, first.leaseId);
    assert.deepEqual(
      release.mock.calls.map(([request]) => request.leaseId),
      [replacement.leaseId],
    );
    assert.equal(primary.details?.leaseRollback, undefined);
    await assert.rejects(
      bound.leases.heartbeat({ ...scope, leaseId: replacement.leaseId }),
      isInactiveLeaseError,
    );
    const unauthorized = createAgentDeviceClient(
      { ...config, daemonAuthToken: 'wrong-test-token' },
      { host },
    );
    await assert.rejects(
      unauthorized.leases.release({ ...scope, leaseId: replacement.leaseId }),
      (error: unknown) => error instanceof AppError && error.code === 'UNAUTHORIZED',
    );
    assert.equal(
      readRemoteConnectionState({ stateDir, session: config.session })?.leaseId,
      first.leaseId,
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.json')), false);
  } finally {
    vi.restoreAllMocks();
    await daemon.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
