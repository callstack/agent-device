import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  HUMAN_CONTROL_LEASE_REQUEST,
  HUMAN_CONTROL_SCOPE,
  isHumanControlError,
  createControlLatch,
} from './human-control-fixtures.ts';

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
  assert.deepEqual(released, { released: true, lease: heartbeat });
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

test('human holds protect leases and release refreshes the original lease TTL atomically', async () => {
  let now = 1_000;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const lease = registry.allocateLease({ ...HUMAN_CONTROL_LEASE_REQUEST, ttlMs: 10_000 });
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  await registry.putHumanControlHold(authority, 'console', {});
  now = 25_000;
  assert.deepEqual(registry.consumeExpiredLeases(), []);
  assert.equal(registry.consumeExpiredLease(lease.leaseId), undefined);
  assert.equal(registry.listActiveLeases()[0]?.leaseId, lease.leaseId);
  assert.throws(
    () => registry.allocateLease({ ...HUMAN_CONTROL_LEASE_REQUEST, runId: 'run-b' }),
    isHumanControlError,
  );
  registry.removeHumanControlHold(authority, 'console');
  assert.equal(registry.listActiveLeases()[0]?.expiresAt, 35_000);
  now = 35_000;
  assert.equal(registry.consumeExpiredLeases()[0]?.leaseId, lease.leaseId);
});

test('hold expiry refreshes from the expiry instant, without reviving abandoned leases', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  await registry.putHumanControlHold(authority, 'console', { ttlMs: 10_000 });
  now = 9_000;
  assert.equal(registry.listActiveLeases().length, 1);
  now = 10_000;
  assert.deepEqual(registry.listHumanControlHolds(authority), []);
  assert.equal(registry.listActiveLeases()[0]?.expiresAt, 15_000);
  now = 15_000;
  assert.deepEqual(registry.listActiveLeases(), []);
});

test('heartbeat and overlapping holds preserve the lease until the final hold ends', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  await registry.putHumanControlHold(authority, 'first', { ttlMs: 10_000 });
  await registry.putHumanControlHold(authority, 'second', { ttlMs: 10_000 });
  now = 7_000;
  const renewed = await registry.putHumanControlHold(authority, 'second', { ttlMs: 10_000 });
  assert.equal(renewed.createdAt, 0);
  assert.equal(renewed.expiresAt, 17_000);
  registry.removeHumanControlHold(authority, 'first');
  now = 12_000;
  assert.throws(() => registry.assertHumanControlAdmission(lease), isHumanControlError);
  assert.equal(registry.consumeExpiredLease(lease.leaseId), undefined);
  now = 17_000;
  assert.doesNotThrow(() => registry.assertHumanControlAdmission(lease));
  assert.equal(registry.listActiveLeases()[0]?.expiresAt, 22_000);
});

test('human control uses the lease backend/provider/device key, never aliases', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  await registry.putHumanControlHold({ kind: 'host' }, 'console', { scope: HUMAN_CONTROL_SCOPE });
  assert.throws(() => registry.assertHumanControlAdmission(lease), isHumanControlError);
  for (const scope of [
    { ...HUMAN_CONTROL_SCOPE, deviceKey: 'sim-1' },
    { ...HUMAN_CONTROL_SCOPE, deviceKey: 'ios:mobile:SIM-1' },
    { ...HUMAN_CONTROL_SCOPE, leaseProvider: 'another-provider' },
    { ...HUMAN_CONTROL_SCOPE, backend: 'ios-simulator' as const },
  ]) {
    assert.doesNotThrow(() => registry.assertHumanControlAdmission(scope));
  }
});

test('lease owners cannot select another device or alter host/other-lease holds', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const other = registry.allocateLease({
    ...HUMAN_CONTROL_LEASE_REQUEST,
    deviceKey: 'other',
    runId: 'run-b',
  });
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  await registry.putHumanControlHold({ kind: 'host' }, 'host', { scope: HUMAN_CONTROL_SCOPE });
  await registry.putHumanControlHold({ kind: 'lease', leaseId: other.leaseId }, 'other', {});
  await assert.rejects(
    registry.putHumanControlHold(authority, 'spoofed', { scope: HUMAN_CONTROL_SCOPE }),
    { code: 'INVALID_ARGS' },
  );
  for (const id of ['host', 'other']) {
    await assert.rejects(registry.putHumanControlHold(authority, id, {}), { code: 'UNAUTHORIZED' });
    assert.throws(() => registry.removeHumanControlHold(authority, id), { code: 'UNAUTHORIZED' });
  }
  assert.deepEqual(
    registry.listHumanControlHolds(authority).map((hold) => hold.id),
    ['host'],
  );
});

test('activation drains admitted mutations, fences new ones, and starts TTL after draining', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now });
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  const finished = createControlLatch();
  const mutation = registry.runDeviceMutation(lease, () => finished.promise);
  let active = false;
  const activation = registry
    .putHumanControlHold(authority, 'console', { ttlMs: 1_000 })
    .then((hold) => {
      active = true;
      return hold;
    });
  await Promise.resolve();
  assert.equal(active, false);
  assert.equal(registry.listHumanControlHolds(authority)[0]?.state, 'activating');
  await assert.rejects(
    registry.runDeviceMutation(lease, async () => 'late mutation'),
    isHumanControlError,
  );
  now = 20_000;
  finished.resolve();
  await mutation;
  const hold = await activation;
  assert.equal(active, true);
  assert.equal(hold.expiresAt, 21_000);
  registry.removeHumanControlHold(authority, 'console');
  assert.equal(await registry.runDeviceMutation(lease, async () => 'resumed'), 'resumed');
});

test('release during activation cannot report a removed hold as active', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  const finished = createControlLatch();
  const mutation = registry.runDeviceMutation(lease, () => finished.promise);
  const activation = registry.putHumanControlHold(authority, 'console', {});
  registry.removeHumanControlHold(authority, 'console');
  const rejected = assert.rejects(activation, { code: 'COMMAND_FAILED' });
  finished.resolve();
  await mutation;
  await rejected;
  assert.deepEqual(registry.listHumanControlHolds(authority), []);
});

test('holds do not survive registry restart, including host holds created without a lease', async () => {
  const registry = new LeaseRegistry();
  await registry.putHumanControlHold({ kind: 'host' }, 'console', { scope: HUMAN_CONTROL_SCOPE });
  assert.throws(() => registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST), isHumanControlError);
  const restarted = new LeaseRegistry();
  assert.deepEqual(restarted.listHumanControlHolds({ kind: 'host' }), []);
  assert.doesNotThrow(() => restarted.allocateLease(HUMAN_CONTROL_LEASE_REQUEST));
});

test('canceled activation refreshes the protected lease without waiting for the mutation', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  const finish = createControlLatch();
  const mutation = registry.runDeviceMutation(lease, () => finish.promise);
  const controller = new AbortController();
  const activation = registry.putHumanControlHold(authority, 'console', {}, controller.signal);
  const canceled = createRequestCanceledError();
  const rejected = assert.rejects(activation, (error) => error === canceled);
  now = 20_000;
  controller.abort(canceled);
  await rejected;
  assert.deepEqual(registry.listHumanControlHolds(authority), []);
  assert.equal(registry.listActiveLeases()[0]?.expiresAt, 25_000);
  finish.resolve();
  await mutation;
  assert.deepEqual(registry.listHumanControlHolds(authority), []);
});

test('canceling a superseded activation cannot remove its successor or another hold', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  const finish = createControlLatch();
  const mutation = registry.runDeviceMutation(lease, () => finish.promise);
  const controller = new AbortController();
  const canceled = createRequestCanceledError();
  const rejected = assert.rejects(
    registry.putHumanControlHold(authority, 'console', {}, controller.signal),
    (error) => error === canceled,
  );
  const successor = registry.putHumanControlHold(authority, 'console', { reason: 'successor' });
  const other = registry.putHumanControlHold(authority, 'other', {});
  controller.abort(canceled);
  await rejected;
  assert.deepEqual(
    registry.listHumanControlHolds(authority).map((hold) => hold.id),
    ['console', 'other'],
  );
  finish.resolve();
  await mutation;
  assert.equal((await successor).reason, 'successor');
  assert.equal((await other).state, 'active');
  await assert.rejects(
    registry.putHumanControlHold(authority, 'console', {}, controller.signal),
    (error) => error === canceled,
  );
  assert.equal(registry.listHumanControlHolds(authority)[0]?.reason, 'successor');
});
