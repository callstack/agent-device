import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  HUMAN_CONTROL_LEASE_REQUEST,
  isHumanControlError,
} from '../../__tests__/support/human-control-fixtures.ts';

test('canceling an active hold re-upsert preserves the hold and blocks device admission', async () => {
  let now = 0;
  const registry = new LeaseRegistry({ now: () => now });
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  const original = await registry.putHumanControlHold(authority, 'console', {
    reason: 'Human is using the device',
    ttlMs: 10_000,
  });
  assert.equal(original.state, 'active');
  now = 1_000;
  const controller = new AbortController();
  const renewal = registry.putHumanControlHold(
    authority,
    'console',
    { reason: 'Renewed hold', ttlMs: 20_000 },
    controller.signal,
  );
  const canceled = createRequestCanceledError();
  const rejected = assert.rejects(renewal, (error) => error === canceled);
  controller.abort(canceled);
  await rejected;

  assert.deepEqual(registry.listHumanControlHolds(authority), [original]);
  assert.throws(() => registry.assertHumanControlAdmission(lease), isHumanControlError);
  await assert.rejects(
    registry.runDeviceMutation(lease, async () => 'unwanted mutation'),
    isHumanControlError,
  );
  now = 10_000;
  assert.deepEqual(registry.listHumanControlHolds(authority), []);
  assert.doesNotThrow(() => registry.assertHumanControlAdmission(lease));
});
