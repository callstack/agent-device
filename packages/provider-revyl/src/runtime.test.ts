import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
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

test('two allocations of one lease that overlap rent one device, and both report it', async () => {
  // The second call arrives while the first `start_device` is still unanswered. Without the join, each
  // one rents a device and the second session replaces the first in the table, leaving the first rented
  // with nothing pointing at it — so shutdown would stop one device and Revyl would hold two.
  const fixture = await backend({ startDelayMs: 200 });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');

  const [first, second] = await Promise.all([
    runtime.leaseLifecycle?.allocate?.(lease),
    runtime.leaseLifecycle?.allocate?.(lease),
  ]);

  assert.deepEqual(
    fixture.paths().filter((path) => path.endsWith('start_device')),
    ['POST /api/v1/execution/start_device'],
  );
  assert.equal(first?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.equal(second?.providerSessionId, revylSessionIdForLease('lease-1'));

  // One rented device means one stop, and after it the runtime holds nothing.
  await runtime.shutdown();
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a joining allocation for a different app or device is refused, not handed the first device', async () => {
  const fixture = await backend({ startDelayMs: 200 });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const first = runtime.leaseLifecycle?.allocate?.(lease, {
    initialApp: 'https://apps.test/a.zip',
  });

  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(lease, {
        initialApp: 'https://apps.test/b.zip',
        flags: { device: 'iPhone 16' },
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-lease-request-mismatch' &&
      JSON.stringify(error.details?.fields) === JSON.stringify(['appUrl', 'deviceModel']),
  );
  // A joiner that names nothing of its own accepts the device the lease already has.
  const [started, joined] = await Promise.all([first, runtime.leaseLifecycle?.allocate?.(lease)]);
  assert.equal(joined?.providerSessionId, started?.providerSessionId);
  assert.equal(fixture.paths().filter((path) => path.endsWith('start_device')).length, 1);
});

test('a joining allocation refuses the flags Revyl has no field for before it joins', async () => {
  // The first caller's start is still unanswered when the second arrives with a flag Revyl reads never.
  // An allocation that reuses a device the daemon already holds carries a profile of its own, and a join
  // that skipped the gate would accept a flag the same caller is refused for on every other path.
  const fixture = await backend({ startDelayMs: 400 });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const first = runtime.leaseLifecycle?.allocate?.(lease);
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));

  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(lease, { flags: { providerProject: 'team' } }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.provider === 'revyl' &&
      error.message.includes('--provider-project'),
  );

  // The refused caller is answered at once, while the caller that rented the device is left alone.
  assert.equal((await first)?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.equal(
    fixture.paths().filter((path) => path.endsWith('/start_device')).length,
    1,
    'the refused join must not rent a device of its own',
  );
});

test('a canceled joiner reports its own cancellation while the shared start runs on', async () => {
  // Both callers wait on one start. The second hangs up first, and the rule is that this changes only
  // what that caller hears: waiting out the first caller's patience instead would report the wrong
  // failure, and stopping the start would take the device from the caller still waiting for it.
  const fixture = await backend({ startDelayMs: 400 });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const first = runtime.leaseLifecycle?.allocate?.(lease);
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));

  const controller = new AbortController();
  const joining = runtime.leaseLifecycle!.allocate!(lease, { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    async () => await joining,
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );

  // The caller that started the device still gets it, and the runtime holds exactly one session.
  assert.equal((await first)?.providerSessionId, revylSessionIdForLease('lease-1'));
  await runtime.shutdown();
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a release that lands while the shared start is still running stops the device it rents', async () => {
  // The daemon drops the lease the moment its caller is gone, and a canceled joiner is gone: this release
  // arrives while the caller that started the device is still waiting for it. The session is not in the
  // table yet, so a release that only read the table would report a device Revyl is about to rent.
  const fixture = await backend({ startDelayMs: 400 });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const first = runtime.leaseLifecycle?.allocate?.(lease);
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));

  const controller = new AbortController();
  const joining = runtime.leaseLifecycle!.allocate!(lease, { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    async () => await joining,
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );

  const released = await runtime.leaseLifecycle!.release!(lease);
  assert.equal(released?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);

  // The caller that rented the device is not made to carry the joiner's release: it still gets its
  // answer, and the runtime holds no session a later shutdown would stop twice.
  assert.equal((await first)?.providerSessionId, revylSessionIdForLease('lease-1'));
  await runtime.shutdown();
  assert.equal(stops(fixture).length, 1);
});

test("a joiner whose deadline expires names its own budget, not the other caller's", async () => {
  // The deadline is the other half of the same rule: a joiner that gave Revyl 60 ms cannot be made to
  // wait for the patience of the caller that started first, and the failure names the wait it was given.
  const fixture = await backend({ startDelayMs: 800 });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  const first = runtime.leaseLifecycle?.allocate?.(lease);
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(lease, { deadline: Date.now() + 60 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-not-ready' &&
      typeof error.details?.timeoutMs === 'number' &&
      error.details.timeoutMs < 700,
  );

  assert.equal((await first)?.providerSessionId, revylSessionIdForLease('lease-1'));
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

test('a release, a recovery and a shutdown that overlap send one stop between them', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { delayMs: 150, body: { success: true, request_accepted: true } } },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  await Promise.all([
    runtime.leaseLifecycle?.release?.(lease),
    runtime.recoverExpiredLease(lease),
    runtime.shutdown(),
  ]);

  assert.deepEqual(stops(fixture), [stopPath]);
});

test('a stop Revyl refuses keeps the lease for a retry and reports the session it could not release', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { body: { success: false, request_accepted: true, message: 'busy' } } },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  // A stop Revyl did not confirm is never reported as a release: the release fails, so the daemon keeps
  // the lease pending instead of recording a device Revyl is still holding and billing.
  await assert.rejects(
    async () => await runtime.leaseLifecycle?.release?.(lease),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-cleanup-pending' &&
      error.details?.providerSessionId === revylSessionIdForLease('lease-1'),
  );

  // The entry keeps its session, so the daemon's retry path retries the same handle.
  await assert.rejects(async () => await runtime.leaseLifecycle?.release?.(lease));
  assert.equal(stops(fixture).length, 2);
});

test('a stop Revyl confirms releases the lease, and a repeat release asks Revyl nothing', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  const released = await runtime.leaseLifecycle!.release!(lease);
  assert.equal(released?.providerSessionId, revylSessionIdForLease('lease-1'));

  // The entry is gone, so there is nothing left to stop and nothing left to report.
  assert.equal(await runtime.leaseLifecycle!.release!(lease), undefined);
  assert.equal(stops(fixture).length, 1);
});

test('a stop that Revyl answers as a gone session reads as released and forgets the lease', async () => {
  const stopPath = `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`;
  const fixture = await backend({
    respond: { [stopPath]: { status: 404, body: { detail: 'no such session' } } },
  });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  // Revyl has nothing left to release, which is the confirmation the entry needed.
  const released = await runtime.leaseLifecycle?.release?.(lease);
  assert.equal(released?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.equal(stops(fixture).length, 1);

  // A repeat release does not reach the backend again.
  assert.equal(await runtime.leaseLifecycle?.release?.(lease), undefined);
  assert.equal(stops(fixture).length, 1);
});

test('shutdown waits for a start already in flight and releases the device it rents', async () => {
  // The worker answers `health` late, so shutdown is certain to overtake the readiness read of a
  // start that has already rented its device.
  const fixture = await backend({ healthDelayMs: 200 });
  const runtime = fixture.createRuntime();
  const allocating = runtime.leaseLifecycle?.allocate?.(revylLease('ios'));
  // The handler goes on before shutdown is asked for, so the rejection below is never unhandled.
  const refused = assert.rejects(
    async () => await allocating,
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'runtime-shutting-down',
  );
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/health')));
  await runtime.shutdown();
  await refused;

  assert.ok(
    stops(fixture).includes(
      `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
    ),
    `shutdown must release the session a start finished renting: ${stops(fixture).join(', ')}`,
  );
});

test('a release that lands mid-start stops the session only once Revyl has made it', async () => {
  // Revyl creates the session when it answers `start_device`, not when it is asked. A `/stop` sent inside
  // that gap names a session Revyl never had, and Revyl's 404 is exactly what a stop reads as "already
  // gone" — so a cleanup that raced the start would report a release and leave the device billed. The fake
  // backend answers such a premature stop with that 404, which makes the ordering the thing under test.
  const fixture = await backend({ startDelayMs: 300, sessionExistsOnceStarted: true });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');

  const allocating = runtime.leaseLifecycle?.allocate?.(lease);
  await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));

  // The release lands while the start is in flight. It waits for the answer rather than stopping the id it
  // only has from the lease, and that is what makes the stop below land after the session exists.
  const released = await runtime.leaseLifecycle!.release!(lease);
  assert.equal(released?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.equal((await allocating)?.providerSessionId, revylSessionIdForLease('lease-1'));

  const answered = fixture.answeredPaths();
  const stopAt = answered.findIndex((path) => path.endsWith('/stop'));
  const startedAt = answered.findIndex((path) => path.endsWith('/start_device'));
  assert.ok(stopAt >= 0 && startedAt >= 0, `both requests reached Revyl: ${answered.join(', ')}`);
  assert.ok(
    stopAt > startedAt,
    `the stop must follow the answer that names the device: ${answered.join(', ')}`,
  );
});

/**
 * The sequences every lease fix has had to satisfy, each one asserted the same way: exactly one confirmed
 * `/stop` per session Revyl actually rented, no stop that Revyl never confirmed read as a release, and
 * never a second device for one lease.
 */
describe('the lease invariant', () => {
  test('a start that answers after its caller gave up is stopped once, by release', async () => {
    const fixture = await backend({ startDelayMs: 300 });
    const runtime = fixture.createRuntime();
    const lease = revylLease('ios');

    await assert.rejects(
      async () => await runtime.leaseLifecycle!.allocate!(lease, { deadline: Date.now() + 120 }),
    );
    await runtime.leaseLifecycle!.release!(lease);

    assert.deepEqual(stops(fixture), [stopPathFor('lease-1')]);
    await runtime.shutdown();
    assert.equal(stops(fixture).length, 1, 'one rented session, one stop');
  });

  test('a start that answers after its caller gave up is stopped once, by shutdown', async () => {
    const fixture = await backend({ startDelayMs: 300 });
    const runtime = fixture.createRuntime();

    await assert.rejects(
      async () =>
        await runtime.leaseLifecycle!.allocate!(revylLease('ios'), { deadline: Date.now() + 120 }),
    );
    await runtime.shutdown();

    assert.deepEqual(stops(fixture), [stopPathFor('lease-1')]);
  });

  test('a cancelled joiner takes no device and stops none', async () => {
    const fixture = await backend({ startDelayMs: 300 });
    const runtime = fixture.createRuntime();
    const lease = revylLease('ios');
    const first = runtime.leaseLifecycle!.allocate!(lease);
    await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));

    const controller = new AbortController();
    const joining = runtime.leaseLifecycle!.allocate!(lease, { signal: controller.signal });
    controller.abort();
    await assert.rejects(async () => await joining);

    assert.equal((await first)?.providerSessionId, revylSessionIdForLease('lease-1'));
    await runtime.shutdown();
    assert.deepEqual(stops(fixture), [stopPathFor('lease-1')]);
  });

  test('a failed stop is retried on the same session until Revyl confirms it', async () => {
    const stopPath = stopPathFor('lease-1');
    let refused = false;
    const fixture = await backend({
      respond: {
        [stopPath]: () => {
          refused = !refused;
          return refused
            ? { status: 500, body: { detail: 'backend down' } }
            : { body: { success: true, request_accepted: true } };
        },
      },
    });
    const runtime = fixture.createRuntime();
    const lease = revylLease('ios');
    await runtime.leaseLifecycle!.allocate!(lease);

    await assert.rejects(
      async () => await runtime.leaseLifecycle!.release!(lease),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'provider-cleanup-pending',
    );
    // The retry is what confirms it, and only then is the lease let go.
    assert.equal(
      (await runtime.leaseLifecycle!.release!(lease))?.providerSessionId,
      revylSessionIdForLease('lease-1'),
    );
    assert.equal(stops(fixture).length, 2);

    await runtime.shutdown();
    assert.equal(stops(fixture).length, 2, 'a confirmed stop is never sent again');
  });

  test('a retry during an in-flight start joins it instead of renting a second device', async () => {
    const fixture = await backend({ startDelayMs: 300 });
    const runtime = fixture.createRuntime();
    const lease = revylLease('ios');

    const first = runtime.leaseLifecycle!.allocate!(lease);
    await waitFor(() => fixture.paths().some((path) => path.endsWith('/start_device')));
    const second = await runtime.leaseLifecycle!.allocate!(lease);

    assert.equal((await first)?.providerSessionId, revylSessionIdForLease('lease-1'));
    assert.equal(second?.providerSessionId, revylSessionIdForLease('lease-1'));
    assert.equal(
      fixture.paths().filter((path) => path.endsWith('/start_device')).length,
      1,
      'one lease rents one device',
    );
    await runtime.shutdown();
    assert.deepEqual(stops(fixture), [stopPathFor('lease-1')]);
  });

  test('shutdown during an in-flight start stops the device it rents', async () => {
    const fixture = await backend({ healthDelayMs: 200 });
    const runtime = fixture.createRuntime();
    const allocating = runtime.leaseLifecycle!.allocate!(revylLease('ios'));
    // The handler goes on before shutdown is asked for, so the rejection below is never unhandled.
    const refused = assert.rejects(
      async () => await allocating,
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'runtime-shutting-down',
    );
    await waitFor(() => fixture.paths().some((path) => path.endsWith('/health')));

    await runtime.shutdown();
    await refused;
    assert.deepEqual(stops(fixture), [stopPathFor('lease-1')]);
  });
});

/** Waits for a fixture-side fact, which is how a test races a start without a fixed sleep. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('The fixture never reached the expected state.');
}

/** The `/stop` path one lease's session is addressed by. */
function stopPathFor(leaseId: string): string {
  return `POST /api/v1/execution/device/sessions/${revylSessionIdForLease(leaseId)}/stop`;
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
        JSON.stringify([revylSessionIdForLease('lease-1')]) &&
      error.message.includes(revylSessionIdForLease('lease-1')),
  );
  assert.equal(stops(fixture).length, 1);

  // The lease keeps its entry across the failed shutdown, so the release that follows retries the same
  // session and fails again rather than recording a release Revyl never confirmed.
  await assert.rejects(
    async () => await runtime.leaseLifecycle?.release?.(lease),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-cleanup-pending' &&
      error.details?.providerSessionId === revylSessionIdForLease('lease-1'),
  );
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
  // would get wrong: the answer that names the device never arrives. The request is not aborted, so that
  // answer still comes and the end is made from what it says.
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

  // The daemon releases a canceled first allocation without asking the provider, so the error is the only
  // place left to name the session a failed late stop would leave rented.
  await assert.rejects(
    async () => await allocating,
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'request_canceled' &&
      error.details?.providerSessionId === revylSessionIdForLease('lease-1') &&
      String(error.details?.hint).includes(revylSessionIdForLease('lease-1')),
  );
  // The stop follows the answer, not the cancellation: the answer is what names the device.
  await waitFor(() =>
    stops(fixture).includes(
      `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
    ),
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
  // The deadline cuts the readiness read short, and the entry ends the session that read was for.
  await waitFor(() => stops(fixture).length > 0);
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a start Revyl refused is not cleaned up as a rented device', async () => {
  // A refusal is the backend answering that it started nothing, so there is no session to stop: the
  // caller's failure is the whole story.
  const fixture = await backend({
    respond: {
      'POST /api/v1/execution/start_device': { status: 401, body: { detail: 'bad key' } },
    },
  });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-auth-rejected',
  );
  assert.deepEqual(stops(fixture), []);
});

test('a start whose verdict never came back is stopped by the session it was issued', async () => {
  // Revyl answered 500, which says nothing about whether the device was rented, so the id the request
  // carried is the handle cleanup has to use.
  const fixture = await backend({
    respond: {
      'POST /api/v1/execution/start_device': { status: 500, body: { detail: 'backend down' } },
    },
  });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(revylLease('ios')),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-unconfirmed',
  );
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a start slower than the allocation budget is given up on and its session stopped', async () => {
  // Revyl is still deciding when the caller's own budget runs out. The caller is answered at once, and the
  // session the late answer names must not survive it.
  const fixture = await backend({ startDelayMs: 400 });
  const runtime = fixture.createRuntime();

  // The wait that ran out is the caller's, so the failure names that budget rather than a cancellation the
  // caller never made.
  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(revylLease('ios'), { deadline: Date.now() + 150 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-not-ready' &&
      error.details?.providerSessionId === revylSessionIdForLease('lease-1'),
  );
  // The readiness polls belong to a start the caller no longer has, so none may have been sent yet.
  assert.equal(
    fixture.paths().filter((path) => path.endsWith('/health')).length,
    0,
    'a start the caller gave up on never reaches readiness',
  );
  await waitFor(() => stops(fixture).length > 0);
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
});

test('a release waits for the answer of a start its caller gave up on and stops what it rented', async () => {
  // The caller's budget ran out while Revyl was still deciding, so the device is only named by the answer
  // that is still to come. A release that landed in the meantime would find no session and report a device
  // Revyl is about to rent.
  const fixture = await backend({ startDelayMs: 400 });
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');

  await assert.rejects(
    async () => await runtime.leaseLifecycle?.allocate?.(lease, { deadline: Date.now() + 150 }),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'provider-not-ready',
  );
  assert.deepEqual(stops(fixture), [], 'the stop waits for the answer that names the device');

  const released = await runtime.leaseLifecycle!.release!(lease);
  assert.equal(released?.providerSessionId, revylSessionIdForLease('lease-1'));
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
  await runtime.shutdown();
  assert.equal(stops(fixture).length, 1, 'the released device is not stopped twice');
});

test('shutdown stops a device whose start answered after its caller gave up', async () => {
  // Nothing is left to release here: the caller's own budget ran out, and the entry that outlived it is the
  // only thing standing between this runtime and a device under rent.
  const fixture = await backend({ startDelayMs: 400 });
  const runtime = fixture.createRuntime();

  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(revylLease('ios'), { deadline: Date.now() + 150 }),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'provider-not-ready',
  );
  await runtime.shutdown();
  assert.deepEqual(stops(fixture), [
    `POST /api/v1/execution/device/sessions/${revylSessionIdForLease('lease-1')}/stop`,
  ]);
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
