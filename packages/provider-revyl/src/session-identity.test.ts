import assert from 'node:assert/strict';
import { test } from 'vitest';
import { revylSessionIdForLease } from './session-identity.ts';

/** Revyl's own UUID pattern for the `session_id` field. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('one lease always derives the same session id', () => {
  const first = revylSessionIdForLease('lease-1');
  assert.match(first, UUID, 'the field is declared as a UUID');
  assert.equal(revylSessionIdForLease('lease-1'), first);
  // Recovery in another process works because the id depends on nothing but the lease.
  assert.equal(revylSessionIdForLease('lease-1'), first);
});

test('two leases never derive one session id', () => {
  const ids = new Set(
    ['lease-1', 'lease-2', 'lease-9', 'revyl:ios:lease-1', ''].map((leaseId) =>
      revylSessionIdForLease(leaseId),
    ),
  );
  assert.equal(ids.size, 5);
  assert.deepEqual(
    [...ids].filter((id) => !UUID.test(id)),
    [],
  );
});
