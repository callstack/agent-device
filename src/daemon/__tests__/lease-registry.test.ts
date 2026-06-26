import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LeaseRegistry } from '../lease-registry.ts';

test('allocateLease creates lease and enforces tenant/run validation', () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
  });
  assert.equal(lease.tenantId, 'tenant-a');
  assert.equal(lease.runId, 'run-1');
  assert.equal(lease.backend, 'ios-simulator');
  assert.ok(lease.leaseId.length >= 16);

  assert.throws(
    () => registry.allocateLease({ tenantId: 'bad tenant', runId: 'run-2' }),
    /Invalid tenant id/,
  );
  assert.throws(
    () => registry.allocateLease({ tenantId: 'tenant-a', runId: 'bad run id' }),
    /Invalid run id/,
  );
});

test('allocateLease is idempotent per tenant/run/backend and refreshes expiry', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({
    now: () => now,
    defaultLeaseTtlMs: 10_000,
  });
  const first = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  now = 2_000;
  const second = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.heartbeatAt, 2_000);
  assert.equal(second.expiresAt, 12_000);
});

test('heartbeatLease extends active lease and releaseLease is idempotent', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({
    now: () => now,
    defaultLeaseTtlMs: 10_000,
  });
  const lease = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  now = 5_000;
  const heartbeat = registry.heartbeatLease({ leaseId: lease.leaseId, ttlMs: 20_000 });
  assert.equal(heartbeat.heartbeatAt, 5_000);
  assert.equal(heartbeat.expiresAt, 25_000);

  const released = registry.releaseLease({ leaseId: lease.leaseId });
  assert.deepEqual(released, { released: true });
  const releasedAgain = registry.releaseLease({ leaseId: lease.leaseId });
  assert.deepEqual(releasedAgain, { released: false });
});

test('heartbeat/release enforce optional tenant/run scope matching', () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });

  assert.throws(
    () => registry.heartbeatLease({ leaseId: lease.leaseId, tenantId: 'tenant-b' }),
    /Lease does not match tenant\/run scope/,
  );
  assert.throws(
    () => registry.releaseLease({ leaseId: lease.leaseId, runId: 'run-2' }),
    /Lease does not match tenant\/run scope/,
  );
});

test('expired leases are cleaned before admission checks', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({
    now: () => now,
    defaultLeaseTtlMs: 5_000,
  });
  const lease = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  now = 7_000;
  assert.throws(
    () =>
      registry.assertLeaseAdmission({
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseId: lease.leaseId,
      }),
    /Lease is not active/,
  );
});

test('capacity limits reject additional simulator leases', () => {
  const registry = new LeaseRegistry({
    maxActiveSimulatorLeases: 1,
  });
  registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  assert.throws(
    () => registry.allocateLease({ tenantId: 'tenant-b', runId: 'run-2' }),
    /No simulator lease capacity available/,
  );
});

test('device-aware allocation is idempotent per tenant/run/backend/provider/device', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({
    now: () => now,
    defaultLeaseTtlMs: 10_000,
  });
  const first = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });

  now = 3_000;
  const second = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });

  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.leaseProvider, 'proxy');
  assert.equal(second.provider, 'proxy');
  assert.equal(second.deviceKey, 'device-1');
  assert.equal(second.clientId, 'client-a');
  assert.equal(second.heartbeatAt, 3_000);
  assert.equal(second.expiresAt, 13_000);
});

test('same backend/provider/device rejects conflicting active lease', () => {
  const registry = new LeaseRegistry();
  const first = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });

  assert.throws(
    () =>
      registry.allocateLease({
        tenantId: 'tenant-b',
        runId: 'run-2',
        backend: 'ios-instance',
        leaseProvider: 'proxy',
        deviceKey: 'device-1',
      }),
    (error) =>
      error instanceof Error &&
      error.message === 'Device is already leased' &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'DEVICE_LEASE_BUSY' &&
      (error as { details?: Record<string, unknown> }).details?.leaseId === first.leaseId,
  );
});

test('device leases are isolated by provider and device key', () => {
  const registry = new LeaseRegistry();
  const proxy = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });
  const limrun = registry.allocateLease({
    tenantId: 'tenant-b',
    runId: 'run-2',
    backend: 'ios-instance',
    leaseProvider: 'limrun',
    deviceKey: 'device-1',
  });
  const secondDevice = registry.allocateLease({
    tenantId: 'tenant-c',
    runId: 'run-3',
    backend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-2',
  });

  assert.notEqual(limrun.leaseId, proxy.leaseId);
  assert.notEqual(secondDevice.leaseId, proxy.leaseId);
});

test('heartbeat enforces device and provider scope when supplied', () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });

  assert.throws(
    () => registry.heartbeatLease({ leaseId: lease.leaseId, deviceKey: 'device-2' }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_MISMATCH',
  );
  assert.throws(
    () => registry.heartbeatLease({ leaseId: lease.leaseId, leaseProvider: 'limrun' }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_MISMATCH',
  );
  assert.throws(
    () => registry.heartbeatLease({ leaseId: lease.leaseId, clientId: 'client-b' }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_MISMATCH',
  );
});

test('expired device lease releases device binding for new clients', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({
    now: () => now,
    defaultLeaseTtlMs: 5_000,
  });
  const first = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });

  now = 7_000;
  const second = registry.allocateLease({
    tenantId: 'tenant-b',
    runId: 'run-2',
    backend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });

  assert.notEqual(second.leaseId, first.leaseId);
});
