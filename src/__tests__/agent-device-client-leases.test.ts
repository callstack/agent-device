import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('lease allocation carries the TestMu device type to the provider flags', async () => {
  const setup = createTransport(async (req) => ({
    ok: true,
    data: {
      lease: {
        leaseId: 'lease-new',
        tenantId: req.meta?.tenantId,
        runId: req.meta?.runId,
        backend: req.meta?.leaseBackend,
      },
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.leases.allocate({
    tenant: 'testmu',
    runId: 'remote-run',
    leaseBackend: 'ios-instance',
    leaseProvider: 'testmu',
    platform: 'ios',
    device: 'iPhone 16',
    providerOsVersion: '18',
    providerDeviceType: 'real',
    providerApp: 'lt://APP1',
  });

  assert.equal(setup.calls[0]?.command, 'lease_allocate');
  assert.equal(setup.calls[0]?.flags?.providerDeviceType, 'real');
  assert.equal(setup.calls[0]?.flags?.providerOsVersion, '18');
});
