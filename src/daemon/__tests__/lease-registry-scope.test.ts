import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createLeaseTtlResolver,
  leaseDeviceBindingKey,
  normalizeAllocateLeaseRequest,
} from '../lease-registry-scope.ts';
import { HUMAN_CONTROL_LEASE_REQUEST, HUMAN_CONTROL_SCOPE } from './human-control-fixtures.ts';

test('allocation and human control share the exact contention identity', () => {
  const scope = normalizeAllocateLeaseRequest(HUMAN_CONTROL_LEASE_REQUEST);
  assert.equal(leaseDeviceBindingKey(scope), leaseDeviceBindingKey(HUMAN_CONTROL_SCOPE));
  assert.notEqual(
    leaseDeviceBindingKey(scope),
    leaseDeviceBindingKey({ ...scope, leaseProvider: 'other' }),
  );
  assert.notEqual(
    leaseDeviceBindingKey(scope),
    leaseDeviceBindingKey({ ...scope, backend: 'ios-simulator' }),
  );
  assert.notEqual(
    leaseDeviceBindingKey(scope),
    leaseDeviceBindingKey({ ...scope, deviceKey: 'sim-1' }),
  );
  assert.equal(leaseDeviceBindingKey({ backend: 'ios-simulator' }), undefined);
});

test('lease TTL normalization retains defaults, limits, and invalid configuration handling', () => {
  const defaults = createLeaseTtlResolver({});
  assert.equal(defaults(undefined), 60_000);
  assert.equal(defaults(1.5), 60_000);
  assert.equal(defaults(5_000), 5_000);
  assert.equal(defaults(600_000), 600_000);
  for (const ttl of [4_999, 600_001]) assert.throws(() => defaults(ttl), { code: 'INVALID_ARGS' });
  const configured = createLeaseTtlResolver({
    defaultLeaseTtlMs: 0,
    minLeaseTtlMs: 0,
    maxLeaseTtlMs: -1,
  });
  assert.equal(configured(undefined), 1);
  assert.equal(configured(1), 1);
  assert.throws(() => configured(2), { code: 'INVALID_ARGS' });
});
