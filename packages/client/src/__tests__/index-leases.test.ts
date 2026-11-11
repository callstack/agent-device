import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../index.ts';
import { createClientTransport } from '@agent-device/test-kit';

test('lease allocation carries the TestMu device type to the provider flags', async () => {
  const setup = createClientTransport(async (req) => ({
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

test('lease allocation sends the device spec and returns the device the backend granted', async () => {
  const setup = createClientTransport(async (req) => ({
    ok: true,
    data: {
      lease: {
        leaseId: 'lease-spec',
        tenantId: req.meta?.tenantId,
        runId: req.meta?.runId,
        backend: req.meta?.leaseBackend,
        deviceKey: 'android:mobile:emulator-5554',
        device: { model: 'Pixel 9', osVersion: '34', imageTag: 'google_apis', physical: false },
      },
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const lease = await client.leases.allocate({
    tenant: 'proxy',
    runId: 'proxy-run',
    leaseBackend: 'android-instance',
    leaseProvider: 'proxy',
    platform: 'android',
    osVersion: '34',
    imageTag: 'google_apis',
    physical: true,
  });

  assert.equal(setup.calls[0]?.flags?.osVersion, '34');
  assert.equal(setup.calls[0]?.flags?.imageTag, 'google_apis');
  assert.equal(setup.calls[0]?.flags?.physical, true);
  assert.deepEqual(lease.device, {
    model: 'Pixel 9',
    osVersion: '34',
    imageTag: 'google_apis',
    physical: false,
  });
});

test('lease allocation sends the iOS simulator mode and returns the mode the backend granted', async () => {
  const device = { model: 'iPhone 17 Pro', osVersion: '26.2', deviceMode: 'full', physical: false };
  const setup = createClientTransport(async (req) => ({
    ok: true,
    data: {
      lease: {
        leaseId: 'lease-mode',
        tenantId: req.meta?.tenantId,
        runId: req.meta?.runId,
        backend: req.meta?.leaseBackend,
        deviceKey: 'ios:mobile:SIM-1',
        device,
      },
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const lease = await client.leases.allocate({
    tenant: 'proxy',
    runId: 'proxy-run',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    platform: 'ios',
    deviceMode: 'full',
  });

  assert.equal(setup.calls[0]?.flags?.deviceMode, 'full');
  assert.deepEqual(lease.device, device);
});

test('lease allocation preserves a padded baseline name in the request and granted device', async () => {
  const device = {
    model: 'iPhone 17 Pro',
    osVersion: '26.2',
    physical: false,
    baseline: { name: ' logged-in ', version: 2 },
  };
  const setup = createClientTransport(async (req) => ({
    ok: true,
    data: {
      lease: {
        leaseId: 'lease-baseline',
        tenantId: req.meta?.tenantId,
        runId: req.meta?.runId,
        backend: req.meta?.leaseBackend,
        deviceKey: 'ios:mobile:SIM-1',
        device,
      },
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const lease = await client.leases.allocate({
    tenant: 'proxy',
    runId: 'proxy-run',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    platform: 'ios',
    deviceBaseline: ' logged-in ',
  });

  assert.equal(setup.calls[0]?.flags?.deviceBaseline, ' logged-in ');
  assert.deepEqual(lease.device, device);
});
