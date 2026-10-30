import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';
import { revylSessionIdForLease } from './session-identity.ts';

const openBackends: RevylFixtureBackend[] = [];

async function backend(options?: Parameters<typeof startRevylFixtureBackend>[0]) {
  const started = await startRevylFixtureBackend(options);
  openBackends.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

/** Stops the fixture recorded, which is what every lifecycle assertion reads. */
function stops(fixture: RevylFixtureBackend): string[] {
  return fixture.paths().filter((path) => path.includes('/stop') || path.includes('/cancel/'));
}

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
    // The session id is the runtime's own, derived from the lease, so a later process can still
    // name this session from the lease alone.
    session_id: revylSessionIdForLease('lease-1'),
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
    providerSessionId: revylSessionIdForLease('lease-1'),
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
  assert.equal(second?.providerSessionId, revylSessionIdForLease('lease-1'));
});

test('release stops the session once, and shutdown stops the sessions a lease never released', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  const lease = revylLease('android');
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;

  await runtime.leaseLifecycle?.allocate?.(lease);
  const released = await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(released?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.deepEqual(released?.warnings, undefined);
  assert.deepEqual(stops(fixture), [stopPath]);

  // A repeat release has nothing left to stop: the session is no longer the runtime's.
  await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(stops(fixture).length, 1);

  await runtime.leaseLifecycle?.allocate?.(revylLease('android', 'lease-2'));
  await runtime.shutdown();
  assert.deepEqual(stops(fixture), [
    stopPath,
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-2')}/stop`,
  ]);
});

test('a stop Revyl refuses keeps the lease for a retry and reports the session it could not release', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { body: { success: false, request_accepted: true, message: 'busy' } } },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  // The refusal is reported, not thrown away, and the release is not claimed.
  const refused = await runtime.leaseLifecycle?.release?.(lease);
  const warning = refused?.warnings as readonly Record<string, unknown>[] | undefined;
  assert.equal(warning?.length, 1);
  assert.equal(warning?.[0]?.code, 'REVYL_SESSION_STOP_FAILED');
  assert.equal(refused?.providerSessionId, revylSessionIdForLease('lease-1'));

  // The lease keeps its session, so the daemon's retry path can try again on the same handle.
  await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(stops(fixture).length, 2);
});

test('a stop that Revyl answers as a gone session reads as released and forgets the lease', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { status: 404, body: { detail: 'no such session' } } },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  const released = await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(released?.warnings, undefined);
  assert.equal(stops(fixture).length, 1);

  // Revyl has nothing left to release, so a repeat release does not reach the backend again.
  await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(stops(fixture).length, 1);
});

test('shutdown waits for a start already in flight and releases the device it rents', async () => {
  // The worker answers `health` late, so shutdown is certain to overtake the readiness read of a
  // start that has already rented its device.
  const fixture = await backend({ healthDelayMs: 200 });
  const runtime = fixture.createRuntime();
  const allocating = runtime.leaseLifecycle?.allocate?.(revylLease('ios'));
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/health')));
  await runtime.shutdown();

  await assert.rejects(
    async () => await allocating,
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'runtime-shutting-down',
  );
  assert.ok(
    stops(fixture).includes(
      `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
    ),
    `shutdown must release the session a start finished renting: ${stops(fixture).join(', ')}`,
  );
});

/** Waits for a fixture-side fact, which is how a test races a start without a fixed sleep. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('The fixture never reached the expected state.');
}

test('shutdown refuses a new allocation instead of renting a device nobody will release', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  await runtime.shutdown();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'runtime-shutting-down',
  );
  assert.equal(
    fixture.paths().filter((path) => path.endsWith('start_device')).length,
    0,
    'a refused allocation must not reach Revyl',
  );
});

test('shutdown reports a session it could not stop instead of forgetting it', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { status: 500, body: { detail: 'backend down' } } },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  await assert.rejects(
    async () => await runtime.shutdown(),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-cleanup-pending' &&
      JSON.stringify(error.details?.providerSessionIds) ===
        JSON.stringify([revylSessionIdForLease('lease-1')]),
  );
  assert.equal(stops(fixture).length, 1);

  // The lease keeps its session across the failed shutdown, so the release that follows retries the
  // same session and reports what is still billed instead of recording a release that never happened.
  const refused = await runtime.leaseLifecycle?.release?.(lease);
  const warning = refused?.warnings as readonly Record<string, unknown>[] | undefined;
  assert.equal(warning?.length, 1);
  assert.equal(warning?.[0]?.code, 'REVYL_SESSION_STOP_FAILED');
  assert.equal(refused?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.equal(stops(fixture).length, 2);
});

test('a session that never became ready is stopped before the failure reaches the caller', async () => {
  const fixture = await backend({ connectionStatuses: ['failed'] });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-start-failed',
  );
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a failed readiness that Revyl could not stop reports the session still rented', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;
  const fixture = await backend({
    connectionStatuses: ['failed'],
    respond: { [stopPath]: { status: 503, body: { detail: 'backend unreachable' } } },
  });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-cleanup-pending' &&
      error.details?.providerSessionId === revylSessionIdForLease('lease-1'),
  );
});

test('a start that returns no run id stops the session it was issued', async () => {
  const fixture = await backend({ startResponse: { workflow_run_id: null } });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-start-refused',
  );
  // Revyl opened a session and only failed to hand back a run, so the session is the handle that
  // has to be ended: a leaked session rents the device for its idle timeout.
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a backend that keeps its own session identity is refused and that session stopped', async () => {
  const fixture = await backend({ startResponse: { session_id: 'someone-elses-session' } });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-session-identity-mismatch',
  );
  // Revyl knows the id it named, so that is the session it has to be told to end; the failure names
  // the same id the stop was addressed to.
  assert.deepEqual(stops(fixture), [
    'POST /api/v1/execution/device/sessions/someone-elses-session/stop',
  ]);
});

test('a start canceled while it is in flight stops the session it rented', async () => {
  // Revyl is still deciding when the caller hangs up, which is the case a bare signal on the request
  // would get wrong: the answer that names the device never arrives.
  const fixture = await backend({ startDelayMs: 200 });
  const runtime = fixture.createRuntime();
  const controller = new AbortController();
  const allocating = runtime.leaseLifecycle?.allocate?.(revylLease('ios'), {
    signal: controller.signal,
    // Long enough that `start_device` is in flight, short enough that readiness could never finish.
    deadline: Date.now() + 30_000,
  });
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));
  controller.abort();

  await assert.rejects(
    async () => await allocating,
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );
  assert.ok(
    stops(fixture).includes(
      `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
    ),
    `a canceled start must stop the device it rented: ${stops(fixture).join(', ')}`,
  );
});

test('an expired allocation deadline stops the start rather than reporting a late success', async () => {
  // The health answer arrives after the remaining budget, which is the shape of a provider that is
  // simply slow: accepting it would outlive the caller's own request.
  const healthPath = 'GET /api/v1/execution/device-proxy/run-1/health';
  const fixture = await backend({ healthDelayMs: 400 });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(revylLease('ios'), { deadline: Date.now() + 150 }),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'provider-not-ready',
  );
  assert.ok(
    fixture.paths().includes(healthPath),
    'the readiness read is what the deadline cuts short',
  );
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a start slower than the allocation budget is given up on and its session stopped', async () => {
  // Revyl is still deciding when the caller's own budget runs out. The request must not be held open
  // past it, and the session that request named must not survive it either.
  const fixture = await backend({ startDelayMs: 400 });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(revylLease('ios'), { deadline: Date.now() + 150 }),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
  // The readiness polls belong to a start the caller no longer has, so none may have been sent.
  assert.equal(
    fixture.paths().filter((path) => path.endsWith('/health')).length,
    0,
    'a start the caller gave up on never reaches readiness',
  );
});

test('Revyl answers health with 503 until the worker attaches, and the start keeps polling', async () => {
  const fixture = await backend({ healthNotReady503Polls: 2 });
  const runtime = fixture.createRuntime();

  const allocation = await runtime.leaseLifecycle?.allocate?.(revylLease('ios'));

  assert.equal(allocation?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.equal(
    fixture.paths().filter((path) => path.endsWith('/health')).length,
    3,
    'a 503 health answer is a not-ready poll, not a failed allocation',
  );
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
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
  await assert.rejects(
    runtime.recoverExpiredLease({ ...revylLease('ios'), backend: 'ios-simulator' }),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
  );
});

test('recoverExpiredLease stops a lease this process never started', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();

  // The daemon restarted: the persisted lease names no in-memory session, and the derived id is the
  // only handle left. Revyl has to be asked, or the device stays rented.
  await runtime.recoverExpiredLease(revylLease('ios', 'lease-9'));

  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-9')}/stop`,
  ]);
});

test('recoverExpiredLease keeps the lease pending when Revyl will not release it', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-9')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { status: 503, body: { detail: 'backend unreachable' } } },
  });
  const runtime = fixture.createRuntime();

  // A recovery that resolves makes the daemon forget the pending release for good.
  await assert.rejects(
    async () => await runtime.recoverExpiredLease(revylLease('ios', 'lease-9')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-cleanup-pending',
  );
});

test('recoverExpiredLease reads a session Revyl no longer has as released', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-9')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { status: 404, body: { detail: 'no such session' } } },
  });
  const runtime = fixture.createRuntime();

  await runtime.recoverExpiredLease(revylLease('ios', 'lease-9'));
  assert.equal(stops(fixture).length, 1);
});
