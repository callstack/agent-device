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
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });

  now = 3_000;
  const second = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });

  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.leaseProvider, 'proxy');
  assert.equal(second.deviceKey, 'device-1');
  assert.equal(second.clientId, 'client-a');
  assert.equal(second.heartbeatAt, 3_000);
  assert.equal(second.expiresAt, 13_000);
});

test('same backend/provider/device rejects conflicting active lease', () => {
  const registry = new LeaseRegistry();
  registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });

  const error = captureThrown(() =>
    registry.allocateLease({
      tenantId: 'tenant-b',
      runId: 'run-2',
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      deviceKey: 'device-1',
    }),
  );

  assert.ok(error instanceof Error);
  assert.equal(error.message, 'Device is already leased');
  const details = (error as { details?: Record<string, unknown> }).details;
  assert.equal(details?.reason, 'DEVICE_LEASE_BUSY');
  assert.equal(details?.leaseId, undefined);
  assert.equal(details?.tenantId, undefined);
  assert.equal(details?.runId, undefined);
});

test('same run/provider/device with different client reports device busy', () => {
  const registry = new LeaseRegistry();
  registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'shared-run',
    leaseBackend: 'ios-instance',
    leaseProvider: 'cloud',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });

  const error = captureThrown(() =>
    registry.allocateLease({
      tenantId: 'tenant-a',
      runId: 'shared-run',
      leaseBackend: 'ios-instance',
      leaseProvider: 'cloud',
      deviceKey: 'device-1',
      clientId: 'client-b',
    }),
  );

  assert.ok(error instanceof Error);
  assert.equal(error.message, 'Device is already leased');
  const details = (error as { details?: Record<string, unknown> }).details;
  assert.equal(details?.reason, 'DEVICE_LEASE_BUSY');
  assert.equal(details?.deviceKey, 'device-1');
  assert.equal(details?.leaseProvider, 'cloud');
});

test('device leases are isolated by provider and device key', () => {
  const registry = new LeaseRegistry();
  const proxy = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });
  const limrun = registry.allocateLease({
    tenantId: 'tenant-b',
    runId: 'run-2',
    leaseBackend: 'ios-instance',
    leaseProvider: 'limrun',
    deviceKey: 'device-1',
  });
  const secondDevice = registry.allocateLease({
    tenantId: 'tenant-c',
    runId: 'run-3',
    leaseBackend: 'ios-instance',
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
    () =>
      registry.heartbeatLease({
        leaseId: lease.leaseId,
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseProvider: 'proxy',
        deviceKey: 'device-2',
        clientId: 'client-a',
      }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_MISMATCH',
  );
  assert.throws(
    () =>
      registry.heartbeatLease({
        leaseId: lease.leaseId,
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseProvider: 'limrun',
        deviceKey: 'device-1',
        clientId: 'client-a',
      }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_MISMATCH',
  );
  assert.throws(
    () =>
      registry.heartbeatLease({
        leaseId: lease.leaseId,
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseProvider: 'proxy',
        deviceKey: 'device-1',
        clientId: 'client-b',
      }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_MISMATCH',
  );
});

test('heartbeat/release require owner scope for device-aware leases', () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });

  assert.throws(
    () => registry.heartbeatLease({ leaseId: lease.leaseId }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_REQUIRED',
  );
  assert.throws(
    () =>
      registry.releaseLease({
        leaseId: lease.leaseId,
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseProvider: 'proxy',
        deviceKey: 'device-1',
      }),
    (error) =>
      error instanceof Error &&
      (error as { details?: Record<string, unknown> }).details?.reason === 'LEASE_SCOPE_REQUIRED',
  );
});

test('consumeExpiredLease removes one expired lease without sweeping unrelated sessions', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({
    now: () => now,
    defaultLeaseTtlMs: 5_000,
  });
  const first = registry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  const second = registry.allocateLease({ tenantId: 'tenant-b', runId: 'run-2' });

  now = 7_000;
  const expired = registry.consumeExpiredLease(first.leaseId);

  assert.equal(expired?.leaseId, first.leaseId);
  assert.equal(registry.consumeExpiredLease(second.leaseId)?.leaseId, second.leaseId);
  assert.deepEqual(registry.consumeExpiredLease(first.leaseId), undefined);
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
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });

  now = 7_000;
  const second = registry.allocateLease({
    tenantId: 'tenant-b',
    runId: 'run-2',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });

  assert.notEqual(second.leaseId, first.leaseId);
});

function captureThrown(task: () => unknown): unknown {
  try {
    task();
    return undefined;
  } catch (error) {
    return error;
  }
}
