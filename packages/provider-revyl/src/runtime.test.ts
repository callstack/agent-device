import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';

const openBackends: RevylFixtureBackend[] = [];

async function backend(options?: Parameters<typeof startRevylFixtureBackend>[0]) {
  const started = await startRevylFixtureBackend(options);
  openBackends.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

test('a lease start waits for the worker and the device, and reports the rented device', async () => {
  const fixture = await backend({ healthNotReadyPolls: 1 });
  const runtime = fixture.createRuntime({ deviceModel: 'iPhone 16', osVersion: '18.0' });
  const lease = revylLease('ios');

  const allocation = await runtime.leaseLifecycle?.allocate?.(lease, {
    initialApp: 'https://apps.test/app.zip',
    flags: { device: 'iPhone 16', providerOsVersion: '18.5' },
  });

  assert.deepEqual(fixture.paths(), [
    'POST /api/v1/execution/start_device',
    'GET /api/v1/execution/streaming/worker-connection/run-1',
    'GET /api/v1/execution/device-proxy/run-1/health',
    'GET /api/v1/execution/device-proxy/run-1/health',
  ]);
  assert.deepEqual(fixture.requests[0]?.body, {
    platform: 'ios',
    is_simulation: true,
    idle_timeout_seconds: 1800,
    app_url: 'https://apps.test/app.zip',
    device_model: 'iPhone 16',
    // The lease context's flags outrank what the runtime was built with.
    os_version: '18.5',
  });
  assert.equal(fixture.requests[0]?.authorization, 'Bearer test-key');
  assert.equal(fixture.requests[0]?.clientHeader, 'agent-device');
  assert.equal(fixture.requests[0]?.agentHeader, undefined);
  assert.deepEqual(allocation, {
    revylRunId: 'run-1',
    providerSessionId: 'session-1',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'revyl:ios:lease-1',
      name: 'Revyl ios run-1',
      kind: 'simulator',
      target: 'mobile',
      booted: true,
    },
  });
});

test('a repeat allocation of a live lease reuses its session without starting a second device', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');

  await runtime.leaseLifecycle?.allocate?.(lease);
  const second = await runtime.leaseLifecycle?.allocate?.(lease);

  assert.equal(fixture.paths().filter((path) => path.endsWith('start_device')).length, 1);
  assert.equal(second?.providerSessionId, 'session-1');
});

test('release stops the session once, and shutdown stops the sessions a lease never released', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  const lease = revylLease('android');

  await runtime.leaseLifecycle?.allocate?.(lease);
  const released = await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(released?.providerSessionId, 'session-1');
  assert.deepEqual(
    fixture.paths().filter((path) => path.includes('/stop')),
    ['POST /api/v1/execution/device/sessions/session-1/stop'],
  );

  // A repeat release has nothing left to stop: the session is no longer the runtime's.
  await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(fixture.paths().filter((path) => path.includes('/stop')).length, 1);

  await runtime.leaseLifecycle?.allocate?.(revylLease('android', 'lease-2'));
  await runtime.shutdown();
  assert.deepEqual(
    fixture.paths().filter((path) => path.includes('/stop')),
    [
      'POST /api/v1/execution/device/sessions/session-1/stop',
      'POST /api/v1/execution/device/sessions/session-1/stop',
    ],
  );
});

test('a session that never became ready is stopped before the failure reaches the caller', async () => {
  const fixture = await backend({ connectionStatuses: ['failed'] });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-start-failed',
  );
  assert.deepEqual(
    fixture.paths().filter((path) => path.includes('/stop')),
    ['POST /api/v1/execution/device/sessions/session-1/stop'],
  );
});

test('a start that returns no run id is refused without a stop, and a session with no id cancels by run', async () => {
  const fixture = await backend({ startResponse: { workflow_run_id: null } });
  const runtime = fixture.createRuntime();
  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-start-refused',
  );
  assert.equal(fixture.paths().filter((path) => path.includes('/stop')).length, 0);

  const noSession = await backend({ startResponse: { session_id: null } });
  const runtime2 = noSession.createRuntime();
  await runtime2.leaseLifecycle?.allocate?.(revylLease('ios'));
  await runtime2.shutdown();
  assert.deepEqual(noSession.paths().at(-1), 'POST /api/v1/execution/device/status/cancel/run-1');
});

test('the inventory provider answers only for its own live leases', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  await runtime.leaseLifecycle?.allocate?.(revylLease('ios'));

  assert.deepEqual(await runtime.deviceInventoryProvider?.({ leaseProvider: 'revyl' }), null);
  assert.deepEqual(
    await runtime.deviceInventoryProvider?.({
      leaseProvider: 'revyl',
      leaseId: 'lease-1',
      platform: 'apple',
    }),
    [
      {
        platform: 'apple',
        appleOs: 'ios',
        id: 'revyl:ios:lease-1',
        name: 'Revyl ios run-1',
        kind: 'simulator',
        target: 'mobile',
        booted: true,
      },
    ],
  );
  // `--platform ios` is the same selector as `--platform apple` for this device.
  assert.equal(
    (
      await runtime.deviceInventoryProvider?.({
        leaseProvider: 'revyl',
        leaseId: 'lease-1',
        platform: 'ios',
      })
    )?.length,
    1,
  );
  assert.deepEqual(
    await runtime.deviceInventoryProvider?.({
      leaseProvider: 'revyl',
      leaseId: 'other',
      platform: 'apple',
    }),
    null,
  );
  // A lease this runtime holds answers an unrelated platform with no devices, not a refusal.
  assert.deepEqual(
    await runtime.deviceInventoryProvider?.({
      leaseProvider: 'revyl',
      leaseId: 'lease-1',
      platform: 'android',
    }),
    [],
  );
  assert.deepEqual(await runtime.deviceInventoryProvider?.({ leaseProvider: 'other' }), null);
});

test('recoverExpiredLease stops the rented session and refuses a foreign lease', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  await runtime.leaseLifecycle?.allocate?.(revylLease('ios'));
  await runtime.recoverExpiredLease(revylLease('ios'));
  assert.deepEqual(
    fixture.paths().filter((path) => path.includes('/stop')),
    ['POST /api/v1/execution/device/sessions/session-1/stop'],
  );
  await assert.rejects(
    runtime.recoverExpiredLease({ ...revylLease('ios'), backend: 'ios-simulator' }),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
  );
});
