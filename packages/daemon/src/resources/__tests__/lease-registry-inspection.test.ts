import { finishTestLease } from '../../__tests__/support/finish-test-lease.ts';
import { expect, test } from 'vitest';
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

test.each(['sessionsSettled', 'providerReleased'] as const)(
  'expiry keeps the device reserved after %s until both parts are confirmed',
  (first) => {
    let now = 1_000;
    const registry = new LeaseRegistry({
      now: () => now,
      onLeaseExpired: () => {},
    });
    const request = { ...HUMAN_CONTROL_LEASE_REQUEST, leaseProvider: 'fixture' };
    const lease = registry.allocateLease(request);
    now = lease.expiresAt;
    expect(registry.consumeExpiredLeases()).toEqual([lease]);
    const next = { ...request, runId: 'successor' };
    const expectBusy = (reason = 'DEVICE_LEASE_BUSY') =>
      expect(() => registry.allocateLease(next)).toThrow(
        expect.objectContaining({
          details: expect.objectContaining({ reason }),
        }),
      );

    expectBusy();
    expect(registry.confirmLeaseEnd(lease.leaseId, first)).toBe(false);
    expectBusy(first === 'providerReleased' ? 'session-cleanup-pending' : 'DEVICE_LEASE_BUSY');
    const second = first === 'sessionsSettled' ? 'providerReleased' : 'sessionsSettled';
    expect(registry.confirmLeaseEnd(lease.leaseId, second)).toBe(true);
    expect(registry.allocateLease(next).leaseId).not.toBe(lease.leaseId);
  },
);

test('an ending lease without a device key keeps its run binding until confirmation', () => {
  let now = 1_000;
  const registry = new LeaseRegistry({
    now: () => now,
    onLeaseExpired: () => {},
  });
  const request = { tenantId: 'tenant', runId: 'run', leaseProvider: 'fixture' };
  const lease = registry.allocateLease(request);
  now = lease.expiresAt;
  registry.consumeExpiredLeases();
  registry.confirmLeaseEnd(lease.leaseId, 'sessionsSettled');
  expect(() => registry.allocateLease(request)).toThrow(
    expect.objectContaining({ details: expect.objectContaining({ reason: 'DEVICE_LEASE_BUSY' }) }),
  );
  expect(registry.confirmLeaseEnd(lease.leaseId, 'providerReleased')).toBe(true);
  expect(registry.allocateLease(request).leaseId).not.toBe(lease.leaseId);
});

test('a delayed expiry reservation cannot fence a renewed host lease with the same ID', async () => {
  let now = 1_000;
  let resume!: () => void;
  const beforeReservation = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const registry = new LeaseRegistry({ now: () => now });
  const leaseId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const lease = registry.putHostLease(leaseId, HUMAN_CONTROL_LEASE_REQUEST);
  now = lease.expiresAt;
  const expired = registry.consumeExpiredLease(leaseId);
  assert.ok(expired);
  const reservation = beforeReservation.then(() =>
    registry.beginLeaseEnd(expired, { sessionsSettled: true, providerRelease: 'confirmed' }),
  );

  const reissued = registry.putHostLease(leaseId, HUMAN_CONTROL_LEASE_REQUEST);
  const work = registry.retainLeaseWork(reissued, () => true);
  now += 1;
  work.release();
  expect(registry.inspectActiveLease(leaseId)?.heartbeatAt).toBe(now);
  resume();

  const reserved = await reservation;
  expect(finishTestLease(registry, { ...HUMAN_CONTROL_LEASE_REQUEST, leaseId }).released).toBe(
    true,
  );
  expect(registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST).leaseId).not.toBe(leaseId);
  expect(reserved).toBe(false);
});

test('a confirmed provider release reports pending session cleanup without a claim refusal', () => {
  const registry = new LeaseRegistry();
  const scope = {
    tenantId: 'tenant-a',
    runId: 'run-a',
    leaseProvider: 'limrun',
    deviceKey: 'ios:fixture',
  };
  const lease = registry.allocateLease(scope);
  registry.beginLeaseEnd(lease, { sessionsSettled: false, providerRelease: 'confirmed' });

  expect(() => registry.allocateLease(scope)).toThrow(
    expect.objectContaining({
      code: 'DEVICE_IN_USE',
      details: expect.objectContaining({ reason: 'session-cleanup-pending' }),
    }),
  );
  const details = registry.leaseEndRefusal(lease.leaseId)?.details;
  expect(details?.reason).toBe('session-cleanup-pending');
  expect(details).not.toHaveProperty('releaseReason');
  expect(details).not.toHaveProperty('releaseStatus');
  expect(registry.confirmLeaseEnd(lease.leaseId, 'sessionsSettled')).toBe(true);
  expect(() => registry.allocateLease(scope)).not.toThrow();
});
