import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LeaseRegistry } from '../lease-registry.ts';
import { HUMAN_CONTROL_LEASE_REQUEST } from '../../__tests__/support/human-control-fixtures.ts';

test('read-only backend inspection matches expiry, holds and in-flight deferral', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const lease = registry.allocateLease({ ...HUMAN_CONTROL_LEASE_REQUEST, ttlMs: 5_000 });
  assert.equal(registry.inspectLeaseBackend(lease.leaseId), lease.backend);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  await registry.putHumanControlHold(authority, 'console', { ttlMs: 7_000 });
  now = 6_000;
  assert.equal(registry.inspectLeaseBackend(lease.leaseId), lease.backend);
  now = 11_999;
  assert.equal(registry.inspectLeaseBackend(lease.leaseId), lease.backend);
  now = 12_000;
  assert.equal(registry.inspectLeaseBackend(lease.leaseId), undefined);
  assert.equal(registry.consumeExpiredLease(lease.leaseId)?.leaseId, lease.leaseId);

  now = 0;
  const deferred = registry.allocateLease({ ...HUMAN_CONTROL_LEASE_REQUEST, runId: 'deferred' });
  const pass = registry.retainLeaseWork(deferred, () => true);
  now = 12_000;
  assert.equal(registry.inspectLeaseBackend(deferred.leaseId), deferred.backend);
  pass.release();
  assert.equal(registry.inspectLeaseBackend(deferred.leaseId), deferred.backend);
  now = 17_000;
  assert.equal(registry.inspectLeaseBackend(deferred.leaseId), undefined);
});

test('read-only backend inspection respects a host-pinned TTL after hold expiry', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const leaseId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const lease = registry.putHostLease(leaseId, {
    ...HUMAN_CONTROL_LEASE_REQUEST,
    ttlMs: 5_000,
  });
  await registry.putHumanControlHold({ kind: 'lease', leaseId }, 'console', { ttlMs: 7_000 });
  now = 11_999;
  assert.equal(registry.inspectLeaseBackend(leaseId), lease.backend);
  now = 12_000;
  assert.equal(registry.inspectLeaseBackend(leaseId), undefined);
  assert.equal(registry.consumeExpiredLease(leaseId)?.leaseId, leaseId);
});

test('expiry consumption rereads a lease protected by its before-consume owner', () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  now = 5_000;
  let inspected = 0;
  let pass: ReturnType<LeaseRegistry['retainLeaseWork']> | undefined;
  const consumed = registry.consumeExpiredLease(lease.leaseId, () => {
    inspected++;
    pass = registry.retainLeaseWork(lease, () => true);
  });
  assert.equal(inspected, 1);
  assert.equal(consumed, undefined);
  assert.equal(registry.inspectLeaseBackend(lease.leaseId), lease.backend);
  pass?.release();
});

test('expiry consumption sweeps expired holds even when the named lease is absent', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  await registry.putHumanControlHold(authority, 'console', { ttlMs: 7_000 });
  now = 7_000;

  assert.equal(registry.consumeExpiredLease('absent'), undefined);
  const heldDevices = (registry as unknown as { holdsByDevice: Map<string, unknown> })
    .holdsByDevice;
  assert.equal(heldDevices.size, 0);
});
