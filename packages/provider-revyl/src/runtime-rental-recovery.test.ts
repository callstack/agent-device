import assert from 'node:assert/strict';
import { test } from 'vitest';
import { revylSessionIdForLease } from './device.ts';
import { revylLease, startRevylFixtureBackend } from './revyl-backend.fixtures.ts';

test('rental recovery accepts a gone session only after Revyl named it', async () => {
  const requested = revylSessionIdForLease('lease-9');
  const exact = revylSessionIdForLease('different-lease');
  const requestedPath = `POST /api/v1/execution/device/sessions/${requested}/stop`;
  const exactPath = `POST /api/v1/execution/device/sessions/${exact}/stop`;
  const absent = { status: 404, body: { detail: 'no such session' } };
  const fixture = await startRevylFixtureBackend({
    respond: { [requestedPath]: absent, [exactPath]: absent },
  });
  try {
    const runtime = fixture.createRuntime();
    const lease = revylLease('ios', 'rental-inherited');
    const recover = runtime.leaseLifecycle.recoverRental!;
    assert.equal(await recover(lease, { reconciliationKey: requested }, () => {}), false);
    assert.equal(
      await recover(lease, { reconciliationKey: requested, instanceId: exact }, () => {}),
      true,
    );
    assert.deepEqual(fixture.paths(), [requestedPath, exactPath]);
  } finally {
    await fixture.close();
  }
});

test('Revyl renews a live rental with callbacks from a new allocation request', async () => {
  const fixture = await startRevylFixtureBackend();
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const submitted: string[] = [];
  const rented: string[] = [];
  const allocate = () =>
    runtime.leaseLifecycle.allocate?.(lease, {
      rental: {
        beforeCreate: (key) => submitted.push(key),
        rented: (id) => rented.push(id),
      },
    });
  try {
    const first = await allocate();
    assert.ok(first);
    assert.deepEqual(await allocate(), first);
    assert.deepEqual(submitted, [revylSessionIdForLease(lease.leaseId)]);
    assert.deepEqual(rented, submitted);
  } finally {
    await runtime.shutdown();
    await fixture.close();
  }
});
