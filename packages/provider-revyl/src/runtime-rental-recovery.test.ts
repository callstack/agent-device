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
    assert.equal(submitted.length, 1);
    assert.deepEqual(rented, submitted);
  } finally {
    await runtime.shutdown();
    await fixture.close();
  }
});

test('a stop for an earlier journaled create cannot end a replacement with the same lease ID', async () => {
  const fixture = await startRevylFixtureBackend({
    sessionExistsOnceStarted: true,
    startResponse: { success: true },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const submitted: string[] = [];
  const allocate = () =>
    runtime.leaseLifecycle.allocate!(lease, {
      rental: {
        beforeCreate: (key) => submitted.push(key),
        rented: () => {},
      },
    });
  try {
    const first = await allocate();
    assert.equal(first?.providerSessionId, submitted[0]);
    assert.equal((await runtime.leaseLifecycle.release!(lease))?.release, 'confirmed');
    const second = await allocate();
    assert.equal(second?.providerSessionId, submitted[1]);
    assert.notEqual(submitted[0], submitted[1]);
    assert.equal(fixture.hasOpenSession(submitted[1]!), true);
    assert.equal(
      await runtime.leaseLifecycle.recoverRental!(lease, { instanceId: submitted[0] }, () => {}),
      true,
    );
    assert.equal(fixture.hasOpenSession(submitted[1]!), true);
    assert.equal((await runtime.leaseLifecycle.release!(lease))?.release, 'confirmed');
    assert.equal(fixture.hasOpenSession(submitted[1]!), false);
    assert.deepEqual(
      fixture.paths().filter((route) => route.endsWith('/stop')),
      [submitted[0], submitted[0], submitted[1]].map(
        (key) => `POST /api/v1/execution/device/sessions/${key}/stop`,
      ),
    );
  } finally {
    await runtime.shutdown();
    await fixture.close();
  }
});

test('live release stays unknown while an unacknowledged create is absent', async () => {
  const fixture = await startRevylFixtureBackend({
    sessionExistsOnceStarted: true,
    respond: { 'POST /api/v1/execution/start_device': { status: 503 } },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const submitted: string[] = [];
  const rented: string[] = [];
  try {
    await assert.rejects(
      runtime.leaseLifecycle.allocate!(lease, {
        rental: {
          beforeCreate: (key) => submitted.push(key),
          rented: (id) => rented.push(id),
        },
      }),
    );
    assert.equal(submitted.length, 1);
    assert.deepEqual(rented, []);
    assert.equal((await runtime.leaseLifecycle.release!(lease))?.release, 'unknown');
    const stopPath = `POST /api/v1/execution/device/sessions/${submitted[0]}/stop`;
    assert.deepEqual(
      fixture.paths().filter((route) => route.endsWith('/stop')),
      [stopPath, stopPath],
    );
  } finally {
    await fixture.close();
  }
});
