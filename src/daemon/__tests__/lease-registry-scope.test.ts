import assert from 'node:assert/strict';
import { test } from 'vitest';
import { leaseDeviceBindingKey, normalizeAllocateLeaseRequest } from '../lease-registry-scope.ts';
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
