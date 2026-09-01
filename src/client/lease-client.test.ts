import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import {
  HUMAN_CONTROL_HOLD,
  HUMAN_CONTROL_SCOPE,
} from '../daemon/__tests__/human-control-fixtures.ts';
import type { DaemonRequest } from '@agent-device/kernel/contracts';

test('human-control client carries normal remote authentication and full lease metadata', async () => {
  const requests: Array<Omit<DaemonRequest, 'token'>> = [];
  const client = createAgentDeviceClient(
    {
      daemonBaseUrl: 'https://daemon.example.test',
      daemonAuthToken: 'tenant-token',
      tenant: 'tenant-a',
      runId: 'run-a',
      leaseId: 'lease-1',
      clientId: 'client-a',
      leaseBackend: HUMAN_CONTROL_SCOPE.backend,
      leaseProvider: HUMAN_CONTROL_SCOPE.leaseProvider,
      deviceKey: HUMAN_CONTROL_SCOPE.deviceKey,
    },
    {
      transport: async (request, context) => {
        assert.equal(context?.authToken, 'tenant-token');
        requests.push(request);
        return {
          ok: true,
          data: { hold: HUMAN_CONTROL_HOLD, holds: [HUMAN_CONTROL_HOLD], released: true },
        };
      },
    },
  );
  assert.equal(
    (await client.leases.humanControl.put('operator-1', { ttlMs: 15_000 })).id,
    'operator-1',
  );
  assert.equal((await client.leases.humanControl.list()).length, 1);
  assert.equal(await client.leases.humanControl.remove('operator-1'), true);
  for (const request of requests) {
    assert.equal(request.command, 'human_control');
    assert.equal(request.meta?.leaseId, 'lease-1');
    assert.equal(request.meta?.leaseProvider, 'proxy');
    assert.equal(request.meta?.deviceKey, HUMAN_CONTROL_SCOPE.deviceKey);
    assert.equal(request.meta?.clientId, 'client-a');
  }
});

test('lease client rejects invalid control responses and preserves normalized errors', async () => {
  const client = createAgentDeviceClient({}, { transport: async () => ({ ok: true, data: {} }) });
  await assert.rejects(client.leases.humanControl.put('operator-1'), { code: 'COMMAND_FAILED' });
  await assert.rejects(client.leases.humanControl.list(), { code: 'COMMAND_FAILED' });
  const denied = createAgentDeviceClient(
    {},
    {
      transport: async () => ({
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Wrong lease',
          details: { reason: 'LEASE_SCOPE_MISMATCH' },
        },
      }),
    },
  );
  await assert.rejects(
    denied.leases.humanControl.remove('operator-1'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNAUTHORIZED' &&
      error.details?.reason === 'LEASE_SCOPE_MISMATCH',
  );
});
