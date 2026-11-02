import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverRuntime, type CloudWebDriverRuntimeOptions } from './runtime.ts';
import { consumeAllProfileFields, refuseAllProfileFields } from './profile-fields.fixtures.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * `POST /session` is billed and the lease is the only handle that can stop it again. Two allocations
 * that overlapped both passed the live-session check, so the second hub session overwrote the first in
 * the manager's map and only one of the two was ever releasable.
 */
test('two concurrent allocations of one lease create one billed session', async () => {
  const hub = startWebDriverHub();
  const preparation = startProviderPreparation();
  const runtime = makeRuntime({ prepareSession: preparation.prepareSession });
  const lease = makeLease();

  try {
    globalThis.fetch = hub.fetch;
    const first = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await preparation.waitFor(1);
    const second = settle(() => runtime.leaseLifecycle.allocate!(lease));
    // One scheduler boundary while the first allocation is still held before the hub: the second has
    // then reached the lease, and the first cannot have published its session yet.
    await schedulerYield();

    const [firstOutcome, secondOutcome] = await Promise.all([
      first,
      second,
      preparation.answerHeld(),
    ]);
    assert.equal(hub.created.length, 1, 'one lease bills one session');
    assertResolvedWith(firstOutcome, 'session-1');
    assertResolvedWith(secondOutcome, 'session-1');

    await runtime.leaseLifecycle.release!(lease);
    assert.deepEqual(hub.deleted, hub.created);
    assert.equal(preparation.cleanups, 1);
  } finally {
    await preparation.answerHeld();
    await runtime.shutdown();
  }
});

/**
 * An allocation that cannot be honoured is refused for its own flags, and one that joins a create in
 * flight is refused for those flags without taking the create's caller down with it: the flags are the
 * caller's, and the session belongs to whoever the lease was first allocated for.
 */
test('an allocation refused for its own flags leaves the create it joined alone', async () => {
  const hub = startWebDriverHub();
  const preparation = startProviderPreparation();
  // This runtime reads none of the Cloud profile fields, so the flags below are refused.
  const runtime = makeRuntime({
    prepareSession: preparation.prepareSession,
    profileFields: refuseAllProfileFields('webdriver-test'),
  });
  const lease = makeLease();
  // The flags bag is keyed by profile field, and `providerApp` is one this runtime refuses.
  const refusedFlags = { providerApp: 'binary-123' };

  try {
    globalThis.fetch = hub.fetch;
    const valid = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await preparation.waitFor(1);
    const refused = settle(() =>
      runtime.leaseLifecycle.allocate!(lease, { flags: refusedFlags } as never),
    );
    await schedulerYield();
    await preparation.answerHeld();

    assertRejectedWith(await refused, 'INVALID_ARGS', { flags: ['--provider-app'] });
    assertResolvedWith(await valid, 'session-1');
    assert.equal(hub.created.length, 1, 'a refused allocation bills nothing');
  } finally {
    await preparation.answerHeld();
    await runtime.shutdown();
  }
});

/**
 * A new allocation publishes its entry before it can await, and its own flags are the create's first
 * step, so a call this provider cannot honour still bills nothing and never reaches preparation.
 */
test('an allocation refused for its own flags bills nothing before it reaches the provider', async () => {
  const hub = startWebDriverHub();
  const preparation = startProviderPreparation();
  const runtime = makeRuntime({
    prepareSession: preparation.prepareSession,
    profileFields: refuseAllProfileFields('webdriver-test'),
  });
  const lease = makeLease();

  try {
    globalThis.fetch = hub.fetch;
    assertRejectedWith(
      await settle(() =>
        runtime.leaseLifecycle.allocate!(lease, { flags: { providerApp: 'b' } } as never),
      ),
      'INVALID_ARGS',
      { flags: ['--provider-app'] },
    );
    assert.deepEqual(hub.created, [], 'a refused allocation never asks the hub to bill a device');
    assert.equal(preparation.started, 0, 'a refused allocation never reaches the provider');
  } finally {
    await runtime.shutdown();
  }
});

/**
 * A release that landed mid-creation found no published session and answered that the lease held
 * nothing, so the hub session that creation went on to make had no route left to stop it. The caller
 * whose session was disposed is refused, rather than handed a session id nothing will release.
 */
test('a release during creation disposes the session that creation makes', async () => {
  const hub = startWebDriverHub();
  const preparation = startProviderPreparation();
  const runtime = makeRuntime({ prepareSession: preparation.prepareSession });
  const lease = makeLease();

  try {
    globalThis.fetch = hub.fetch;
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await preparation.waitFor(1);
    // The release takes the lease in its first synchronous step, while the create is held.
    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));
    await preparation.answerHeld();

    assert.deepEqual(await releasing, {
      status: 'resolved',
      value: { provider: 'webdriver-test', providerSessionId: 'session-1' },
    });
    assert.deepEqual(hub.deleted, ['session-1']);
    assert.equal(preparation.cleanups, 1);
    assertRejectedWith(await allocating, 'provider_session_released_during_allocation', {
      leaseId: lease.leaseId,
      providerSessionId: 'session-1',
      cleanup: 'confirmed',
    });
  } finally {
    await preparation.answerHeld();
    await runtime.shutdown();
  }
});

/** The same race on the route that ends every session this process holds. */
test('shutdown during creation disposes the session that creation makes', async () => {
  const hub = startWebDriverHub();
  const preparation = startProviderPreparation();
  const runtime = makeRuntime({ prepareSession: preparation.prepareSession });
  const lease = makeLease();

  try {
    globalThis.fetch = hub.fetch;
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await preparation.waitFor(1);
    // Shutdown takes every lease in its first synchronous step, while the create is held.
    const shuttingDown = settle(() => runtime.shutdown());
    await preparation.answerHeld();

    assert.deepEqual(await shuttingDown, { status: 'resolved', value: undefined });
    assert.deepEqual(hub.deleted, ['session-1']);
    assert.equal(preparation.cleanups, 1);
    assertRejectedWith(await allocating, 'provider_session_shutdown_during_allocation', {
      leaseId: lease.leaseId,
      providerSessionId: 'session-1',
      cleanup: 'confirmed',
    });
  } finally {
    await preparation.answerHeld();
    await runtime.shutdown();
  }
});

/**
 * Taking a lease out of the map to dispose it opened the lease up again: an allocation that arrived
 * while that disposal still waited on the hub saw nothing holding the lease and rented a second session
 * the release could never see, and a shutdown that arrived in the same window answered with the first
 * session live. Until the disposal settles, the lease belongs to the route that is ending it.
 */
test('an allocation that arrives during a release still disposing creates no second session', async () => {
  // The hub keeps the release's DELETE pending, which is the window this test needs.
  const hub = startWebDriverHub({ heldDeletes: 1 });
  const preparation = startProviderPreparation();
  const runtime = makeRuntime({ prepareSession: preparation.prepareSession });
  const lease = makeLease();

  try {
    globalThis.fetch = hub.fetch;
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await preparation.waitFor(1);
    await preparation.answerHeld();
    assertResolvedWith(await allocating, 'session-1');

    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));
    const racing = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await schedulerYield();
    assert.equal(
      hub.created.length,
      1,
      'an allocation that arrives mid-release must not bill a second session',
    );
    assert.equal(preparation.started, 1, 'an allocation refused mid-release prepares nothing');

    const shuttingDown = settle(() => runtime.shutdown());
    await schedulerYield();
    // The release is still waiting on the hub, so neither it nor the shutdown may have answered.
    assert.deepEqual(hub.deleted, []);
    assert.equal(await alreadySettled(shuttingDown), false, 'shutdown must await the release');

    hub.answerHeldDeletes();
    assertRejectedWith(await racing, 'provider_session_release_in_progress', {
      leaseId: lease.leaseId,
      providerSessionId: 'session-1',
    });
    // Shutdown joined the disposal that was already running, so no session of this provider outlives it.
    assert.deepEqual(await shuttingDown, { status: 'resolved', value: undefined });
    assert.deepEqual(hub.deleted, ['session-1']);
    assert.equal(preparation.cleanups, 1);
    assert.deepEqual(await releasing, {
      status: 'resolved',
      value: { provider: 'webdriver-test', providerSessionId: 'session-1' },
    });
  } finally {
    hub.answerHeldDeletes();
    await preparation.answerHeld();
    await runtime.shutdown();
  }
});

/**
 * A repeated allocation used to answer for the live session and then await, which gave a release room to
 * end that session before the answer reached the caller, who was told the lease was alive. Its flags are
 * validated first and the answer that follows the lookup carries no await, so a release that gets there
 * first is the outcome the caller gets instead.
 */
test('a repeated allocation cannot answer that a released lease is alive', async () => {
  // The hub holds the release's DELETE, so the release is certainly still ending the session at the
  // moment the repeat allocation answers.
  const hub = startWebDriverHub({ heldDeletes: 1 });
  globalThis.fetch = hub.fetch;
  const runtime = makeRuntime();
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    assert.deepEqual(hub.created, ['session-1']);
    // The healthy case first: a repeat allocation of a live lease reports that lease as held.
    assert.deepEqual(await runtime.leaseLifecycle.allocate!(lease), {
      provider: 'webdriver-test',
    });

    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));
    const repeated = settle(() => runtime.leaseLifecycle.allocate!(lease));
    assertRejectedWith(await repeated, 'provider_session_release_in_progress', {
      leaseId: lease.leaseId,
      providerSessionId: 'session-1',
      cleanup: 'pending',
    });
    assert.equal(hub.created.length, 1, 'a refused repeat allocation bills nothing');

    hub.answerHeldDeletes();
    assert.deepEqual(await releasing, {
      status: 'resolved',
      value: { provider: 'webdriver-test', providerSessionId: 'session-1' },
    });
    assert.deepEqual(hub.deleted, ['session-1']);
  } finally {
    hub.answerHeldDeletes();
    await runtime.shutdown();
  }
});

/**
 * The same window on the route that ends every session: a shutdown that lands first is the outcome a
 * repeat allocation reports, rather than a success with no session behind it.
 */
test('a repeated allocation cannot answer that a shut down lease is alive', async () => {
  const hub = startWebDriverHub({ heldDeletes: 1 });
  globalThis.fetch = hub.fetch;
  const runtime = makeRuntime();
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    assert.deepEqual(hub.created, ['session-1']);

    const shuttingDown = settle(() => runtime.shutdown());
    const repeated = settle(() => runtime.leaseLifecycle.allocate!(lease));
    assertRejectedWith(await repeated, 'provider_session_shutdown_during_allocation', {
      leaseId: lease.leaseId,
      providerSessionId: 'session-1',
      cleanup: 'pending',
    });
    assert.equal(hub.created.length, 1, 'a refused repeat allocation bills nothing');

    hub.answerHeldDeletes();
    assert.deepEqual(await shuttingDown, { status: 'resolved', value: undefined });
    assert.deepEqual(hub.deleted, ['session-1']);
  } finally {
    hub.answerHeldDeletes();
    await runtime.shutdown();
  }
});

/**
 * An allocation reaches its first await before provider preparation begins, and a release issued in
 * that moment used to find nothing holding the lease and answer that it had released it. The create that
 * went on to run then billed a session no route was left to stop. The lease has to belong to the
 * allocation from the moment it is asked for, so the release ends up taking it and disposing what the
 * create rents.
 */
test('a release issued before provider preparation begins disposes the session the allocation rents', async () => {
  const hub = startWebDriverHub();
  const preparation = startProviderPreparation();
  const runtime = makeRuntime({ prepareSession: preparation.prepareSession });
  const lease = makeLease();

  try {
    globalThis.fetch = hub.fetch;
    // Both calls are issued in one synchronous step, so the release reaches the manager while the
    // allocation is at its first await and provider preparation has not answered.
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(lease));
    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));
    assert.deepEqual(hub.created, [], 'nothing may be billed before preparation answers');
    // The allocation has reached provider preparation, which is still held.
    await preparation.waitFor(1);
    await preparation.answerHeld();

    assert.deepEqual(await releasing, {
      status: 'resolved',
      value: { provider: 'webdriver-test', providerSessionId: 'session-1' },
    });
    assertRejectedWith(await allocating, 'provider_session_released_during_allocation', {
      leaseId: lease.leaseId,
      providerSessionId: 'session-1',
      cleanup: 'confirmed',
    });
    // The session the create rented is gone: a release that reported success leaves no billed session.
    assert.deepEqual(hub.deleted, ['session-1']);
  } finally {
    await preparation.answerHeld();
    await runtime.shutdown();
  }
});

/**
 * Ending a session ends the billed resource and hands back what the provider prepared; the artifact
 * lookup that follows is only what the release envelope reports. A plugin's own artifact callback has
 * no bound of its own, so it may not be what keeps a lease from being allocated again, what keeps a
 * second release from answering, or what a daemon close waits through.
 */
test('an artifact callback that never answers holds neither the lease nor shutdown', async () => {
  const hub = startWebDriverHub();
  globalThis.fetch = hub.fetch;
  let answerArtifacts: (() => void) | undefined;
  const lookupStarted = startSignal();
  const runtime = makeRuntime({
    providerCallbackTimeoutMs: 40,
    listArtifacts: async () => {
      lookupStarted.report();
      await new Promise<void>((ready) => {
        answerArtifacts = ready;
      });
      return { provider: 'webdriver-test', status: 'ready', cloudArtifacts: [] };
    },
  });
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));
    // The lookup starts only once the hub has ended the session and the provider's cleanup has answered,
    // so its having started is the moment the billed work is finished.
    await awaitSignal(lookupStarted.arrived, 'the artifact lookup to start');
    assert.deepEqual(hub.deleted, ['session-1']);
    await schedulerYield();

    // A re-allocation during the hanging lookup is the lease's own business, not the lookup's.
    const reallocated = settle(() => runtime.leaseLifecycle.allocate!(lease));
    assertResolvedWith(await reallocated, 'session-2', describe(await reallocated));
    const shuttingDown = settle(() => runtime.shutdown());
    assert.deepEqual(
      await shuttingDown,
      { status: 'resolved', value: undefined },
      'shutdown may not wait on an optional artifact lookup',
    );

    const result = await releasing;
    assert.equal(result.status, 'resolved', describe(result));
    const value = (result as Readonly<{ value: Record<string, unknown> | undefined }>).value;
    assert.equal(value?.providerSessionId, 'session-1');
    // What the lookup could not answer for becomes an unavailable report, the way its failures do.
    assert.equal(
      (value?.cloudArtifacts as Record<string, unknown> | undefined)?.status,
      'unavailable',
    );
    assert.deepEqual(hub.created, ['session-1', 'session-2']);
    assert.deepEqual(hub.deleted, ['session-1', 'session-2']);
  } finally {
    answerArtifacts?.();
    await runtime.shutdown();
  }
});

/**
 * A provider's own cleanup is the half of disposal the hub's `DELETE` does not cover, and a custom one
 * has no bound either. Once its budget runs out this manager cannot learn whether the resource was
 * handed back, so it says so and lets the lease be used again rather than holding it forever.
 */
test('a provider cleanup that outlives its budget ends the disposal as uncertain', async () => {
  const hub = startWebDriverHub();
  globalThis.fetch = hub.fetch;
  let answerCleanup: (() => void) | undefined;
  let cleanupCalls = 0;
  const runtime = makeRuntime({
    providerCallbackTimeoutMs: 40,
    prepareSession: async ({ base }) => ({
      ...base,
      cleanup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls > 1) return undefined;
        await new Promise<void>((ready) => {
          answerCleanup = ready;
        });
        return undefined;
      },
    }),
  });
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));
    await hub.deletedArrived('session-1');

    const result = await releasing;
    assert.equal(result.status, 'resolved', describe(result));
    const value = (result as Readonly<{ value: Record<string, unknown> | undefined }>).value;
    assert.deepEqual(warningCodes(value?.warnings), ['PROVIDER_CLEANUP_FAILED']);
    assert.match(String(warningMessages(value?.warnings)[0]), /40ms/);

    // The lease is the next caller's again, and a later session this manager can end still ends cleanly.
    assertResolvedWith(
      await settle(() => runtime.leaseLifecycle.allocate!(lease)),
      'session-2',
      'a cleanup whose outcome is unknown may not keep the lease',
    );
    assert.deepEqual(
      await settle(() => runtime.shutdown()),
      { status: 'resolved', value: undefined },
      'only a session the provider would not end may fail a close',
    );
    assert.deepEqual(hub.created, ['session-1', 'session-2']);
    assert.deepEqual(hub.deleted, ['session-1', 'session-2']);
  } finally {
    answerCleanup?.();
    await runtime.shutdown();
  }
});

/**
 * A hub that will not end a session leaves it billing, so the release that was told to end it names the
 * session and the provider's refusal, exactly as it does for a session it was handed ready-made.
 */
test('a release the provider refused reports the session left running', async () => {
  const hub = startWebDriverHub({ deleteFailure: 'provider rejected the delete' });
  globalThis.fetch = hub.fetch;
  const runtime = makeRuntime();
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));

    const result = await releasing;
    assert.equal(result.status, 'resolved', describe(result));
    const value = (result as Readonly<{ value: Record<string, unknown> | undefined }>).value;
    assert.equal(value?.providerSessionId, 'session-1');
    assert.deepEqual(warningCodes(value?.warnings), ['WEBDRIVER_SESSION_DELETE_FAILED']);
    assert.match(String(warningMessages(value?.warnings)[0]), /provider rejected the delete/);
    assert.deepEqual(hub.deleted, []);
  } finally {
    hub.allowDeletes();
    await runtime.shutdown();
  }
});

/**
 * A create the hub refused still hands back what the provider prepared, and that hand-back is the
 * plugin's own code too. A `cleanup` that never answers there would keep the allocation from answering,
 * with the lease held behind it and nothing on the lease left to end, so it gets the same budget the
 * disposal's cleanup gets.
 */
test('a create the hub refused still answers when its provider cleanup hangs', async () => {
  const hub = startWebDriverHub({ createFailure: 'hub refused the create' });
  globalThis.fetch = hub.fetch;
  let answerCleanup: (() => void) | undefined;
  const runtime = makeRuntime({
    providerCallbackTimeoutMs: 40,
    prepareSession: async ({ base }) => ({
      ...base,
      cleanup: async () => {
        await new Promise<void>((ready) => {
          answerCleanup = ready;
        });
        return undefined;
      },
    }),
  });
  const lease = makeLease();

  try {
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(lease));
    // The create failed and its cleanup is the step that will not answer, so the allocation cannot be
    // left waiting on it.
    const outcome = await allocating;
    assert.equal(
      outcome.status,
      'rejected',
      `the refused create still reports the hub's own refusal, got ${describe(outcome)}`,
    );
    const error = (outcome as Readonly<{ error: AppError }>).error;
    const details = (error.details ?? {}) as Record<string, unknown>;
    assert.equal(details.status, 500, 'the hub refusal is what the caller is told');
    assert.match(String(details.cleanupError), /did not answer within 40ms/);

    // The lease is the next caller's again: an allocation issued after the hung cleanup reaches the hub
    // and is refused for the hub's own refusal, not for a teardown that never finishes. And a close does
    // not wait on a callback it gave up on.
    const nextAllocation = await settle(() => runtime.leaseLifecycle.allocate!(lease));
    assert.equal(nextAllocation.status, 'rejected', describe(nextAllocation));
    const nextDetails = ((nextAllocation as Readonly<{ error: AppError }>).error.details ??
      {}) as Record<string, unknown>;
    assert.equal(
      nextDetails.status,
      500,
      'the lease is free, so this caller hears the hub again rather than a contention refusal',
    );
    assert.deepEqual(
      await settle(() => runtime.shutdown()),
      { status: 'resolved', value: undefined },
      'a create cleanup this manager gave up on may not hold a close',
    );
    assert.deepEqual(hub.created, []);
  } finally {
    answerCleanup?.();
    await runtime.shutdown();
  }
});

/**
 * A close reports every session it left billing, and each session keeps its own reason in that report:
 * two sessions the provider refused to end carry two refusals, and collapsing them by warning code would
 * hand the operator one message for both.
 */
test('a shutdown that could not stop two sessions names both refusals', async () => {
  const hub = startWebDriverHub({ deleteFailure: 'provider rejected the delete' });
  globalThis.fetch = hub.fetch;
  const runtime = makeRuntime();
  const first = { ...makeLease(), leaseId: 'lease-a' };
  const second = { ...makeLease(), leaseId: 'lease-b' };

  try {
    await runtime.leaseLifecycle.allocate!(first);
    await runtime.leaseLifecycle.allocate!(second);
    assert.deepEqual(hub.created, ['session-1', 'session-2']);

    const shuttingDown = await settle(() => runtime.shutdown());
    assert.equal(
      shuttingDown.status,
      'rejected',
      'a close that left two sessions billing is not a clean close',
    );
    const details = ((shuttingDown as Readonly<{ error: AppError }>).error.details ?? {}) as Record<
      string,
      unknown
    >;
    assert.equal(details.reason, 'provider_session_cleanup_incomplete');
    assert.deepEqual(details.providerSessionIds, ['session-1', 'session-2']);
    // Each named session carries the reason this provider gave for it, so an operator can tell the two
    // refusals apart instead of being handed one message for both sessions.
    const warnings = details.cleanupWarnings as Array<Record<string, unknown>>;
    assert.deepEqual(
      warnings.map((warning) => [warning.providerSessionId, warning.code]),
      [
        ['session-1', 'WEBDRIVER_SESSION_DELETE_FAILED'],
        ['session-2', 'WEBDRIVER_SESSION_DELETE_FAILED'],
      ],
    );
    assert.deepEqual(
      warnings.map((warning) => /session-\d/.exec(String(warning.message))?.[0]),
      ['session-1', 'session-2'],
    );
  } finally {
    hub.allowDeletes();
    await runtime.shutdown();
  }
});

/**
 * A shutdown that could not stop a session may not report a clean close, and the allocation whose
 * session it was is told the outcome is uncertain rather than that nothing needs cleaning up.
 */
test('a session shutdown could not stop fails the shutdown and the refused allocation', async () => {
  const hub = startWebDriverHub({ deleteFailure: 'provider rejected the delete' });
  const preparation = startProviderPreparation();
  const runtime = makeRuntime({ prepareSession: preparation.prepareSession });
  const lease = makeLease();

  try {
    globalThis.fetch = hub.fetch;
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await preparation.waitFor(1);
    const shuttingDown = settle(() => runtime.shutdown());
    await preparation.answerHeld();

    assertRejectedWith(await allocating, 'provider_session_shutdown_during_allocation', {
      leaseId: lease.leaseId,
      providerSessionId: 'session-1',
      cleanup: 'uncertain',
      cleanupWarning: 'WEBDRIVER_SESSION_DELETE_FAILED',
    });
    // A daemon close reports a plugin that left work behind, so the session and the provider's refusal
    // have to travel on the error rather than be dropped.
    assertRejectedWith(await shuttingDown, 'provider_session_cleanup_incomplete', {
      providerSessionIds: ['session-1'],
      cleanup: 'uncertain',
      cleanupWarning: 'WEBDRIVER_SESSION_DELETE_FAILED',
    });
    // The create-retry policy stays: nothing here deletes or creates a second session on its own.
    assert.deepEqual(hub.created, ['session-1']);
    assert.deepEqual(hub.deleted, []);
    assert.equal(preparation.cleanups, 1);
  } finally {
    hub.allowDeletes();
    await preparation.answerHeld();
    await runtime.shutdown();
  }
});

/**
 * The hub answers every WebDriver request and records the session ids it was asked to create and
 * delete, so a test's levers over an in-flight create and an in-flight disposal are
 * {@link startProviderPreparation} and the `heldDeletes` option.
 */
function startWebDriverHub(
  options: Readonly<{
    deleteFailure?: string;
    heldDeletes?: number;
    createFailure?: string;
  }> = {},
) {
  const created: string[] = [];
  const deleted: string[] = [];
  let deletesToHold = options.heldDeletes ?? 0;
  let deleteFailure = options.deleteFailure;
  const held: (() => void)[] = [];
  /** Per-session arrival so a test can await the hub ending one rather than watching the clock. */
  const deleteSignals = new Map<string, ReturnType<typeof startSignal>>();
  const signalForDelete = (sessionId: string) => {
    const existing = deleteSignals.get(sessionId) ?? startSignal();
    deleteSignals.set(sessionId, existing);
    return existing;
  };
  return {
    created,
    deleted,
    /** Resolves once the hub has answered a `DELETE` for `sessionId`. */
    deletedArrived: async (sessionId: string) => {
      await awaitSignal(signalForDelete(sessionId).arrived, `the hub to end session ${sessionId}`);
    },
    allowDeletes: () => {
      deleteFailure = undefined;
    },
    /** Lets every held `DELETE` finish, which is how a release that is still disposing resumes. */
    answerHeldDeletes: () => {
      for (const ready of held.splice(0)) ready();
    },
    fetch: (async (input: unknown, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.endsWith('/session')) {
        if (options.createFailure) {
          return jsonResponse(
            { value: { error: 'unknown error', message: `${options.createFailure}` } },
            500,
          );
        }
        const sessionId = `session-${String(created.length + 1)}`;
        created.push(sessionId);
        return jsonResponse({ sessionId, capabilities: {} });
      }
      if (request.method === 'DELETE') {
        const sessionId = decodeURIComponent(path.split('/').pop()!);
        if (deletesToHold > 0) {
          deletesToHold -= 1;
          await new Promise<void>((ready) => {
            held.push(ready);
          });
        }
        if (deleteFailure) {
          return jsonResponse(
            { value: { error: 'unknown error', message: `${deleteFailure}: ${sessionId}` } },
            500,
          );
        }
        deleted.push(sessionId);
        signalForDelete(sessionId).report();
      }
      return jsonResponse({ value: null });
    }) as typeof fetch,
  };
}

type PrepareSession = NonNullable<CloudWebDriverRuntimeOptions['prepareSession']>;

/**
 * How long an arrival wait gives a step that has not happened at all. It is a watchdog, not a poll
 * budget: the step that arrives resolves its own signal in that same step, however slow the worker is,
 * so this only ever elapses on a manager or a seam that never reached the step.
 */
const ARRIVAL_BUDGET_MS = 2_000;

/**
 * Waits for a step to be reported — a create that reached the provider, the hub asked to delete a
 * session, a plugin callback that was entered — rather than polling the clock for it. The timer only
 * names a step that never came, so a slow worker cannot fail a test whose allocation is progressing.
 */
async function awaitSignal(signal: Promise<void>, step: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const arrived = await Promise.race([
      signal.then(() => true),
      new Promise<boolean>((giveUp) => {
        timer = setTimeout(() => giveUp(false), ARRIVAL_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
    assert.ok(arrived, `the manager never reached ${step}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A step a test waits to be reported, reported once by the seam that reaches it.
 */
function startSignal() {
  let reportArrival!: () => void;
  const arrived = new Promise<void>((ready) => {
    reportArrival = ready;
  });
  let reported = false;
  return {
    arrived,
    report: () => {
      if (reported) return;
      reported = true;
      reportArrival();
    },
  };
}

/**
 * `prepareSession` is the step that runs before this manager sends `POST /session`, so holding it per
 * call keeps a create in flight across a release or a shutdown without racing one with a sleep. It
 * counts the creates that reached the provider — the difference between one billed session and two —
 * and the provider cleanup a prepared session owes, which is the half of disposal the hub's `DELETE`
 * does not cover.
 */
function startProviderPreparation() {
  const state = { started: 0, cleanups: 0 };
  const calls: { readonly released: boolean; readonly release: () => void }[] = [];
  /** Who is waiting to hear that a create has reached the provider. */
  const waiting: (() => void)[] = [];
  const prepareSession: PrepareSession = async ({ base }) => {
    state.started += 1;
    const call = { released: false, release: () => {} };
    const held = new Promise<void>((ready) => {
      call.release = () => {
        if (call.released) return;
        call.released = true;
        ready();
      };
    });
    calls.push(call);
    // This create has arrived, so anyone waiting for one hears it in this same step rather than on the
    // next round of a poll.
    for (const announce of waiting.splice(0)) announce();
    await held;
    return {
      ...base,
      cleanup: async () => {
        state.cleanups += 1;
        return undefined;
      },
    };
  };
  return Object.assign(state, {
    prepareSession,
    /**
     * Resolves once `expected` allocations have reached the provider and are held there. Each wait is
     * ended by the arrival itself, so a test neither polls the scheduler nor races the create; the one
     * timer only reports a create that never arrived, and never elapses while the seam works.
     */
    waitFor: async (expected: number) => {
      while (calls.length < expected) {
        await awaitSignal(
          new Promise<void>((announce) => {
            waiting.push(announce);
          }),
          `${String(expected)} allocation(s) to reach the provider (got ${String(calls.length)})`,
        );
      }
    },
    /** Lets every create that is held reach the hub. */
    answerHeld: async () => {
      for (const call of calls) call.release();
      await schedulerYield();
    },
  });
}

/** How one lease-lifecycle call ended, so a test can assert disposal before the caller's outcome. */
type Settled<T> =
  | Readonly<{ status: 'resolved'; value: T }>
  | Readonly<{ status: 'rejected'; error: unknown }>;

/** Runs a call and turns its outcome into a value, so no rejection goes unobserved. */
async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { status: 'resolved', value: await run() };
  } catch (error) {
    return { status: 'rejected', error };
  }
}

/** Whether a call has answered, so a test can name work that must still be pending. */
async function alreadySettled<T>(outcome: Promise<Settled<T>>): Promise<boolean> {
  return await Promise.race([
    outcome.then(() => true),
    new Promise<boolean>((pending) => {
      setTimeout(() => pending(false), 0);
    }),
  ]);
}

/** Yields one macrotask, so every promise the test has started runs the microtasks it already queued. */
async function schedulerYield(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The allocation envelope names the hub session the lease now holds. */
function assertResolvedWith(
  outcome: Settled<Record<string, unknown> | undefined>,
  sessionId: string,
  expectation?: string,
): void {
  assert.equal(
    outcome.status,
    'resolved',
    `${expectation ?? `expected ${sessionId}`}, got ${describe(outcome)}`,
  );
  assert.equal(
    (outcome as Readonly<{ value: Record<string, unknown> | undefined }>).value?.sessionId,
    sessionId,
  );
}

/**
 * What a refused call reports: its typed reason or error code, the lease and session it was refused
 * for, and what the teardown that took the session came to.
 */
function assertRejectedWith(
  outcome: Settled<unknown>,
  reason: string,
  expected: Readonly<{
    leaseId?: string;
    providerSessionId?: string;
    providerSessionIds?: string[];
    cleanup?: string;
    cleanupWarning?: string;
    flags?: string[];
  }> = {},
): void {
  assert.equal(outcome.status, 'rejected', `expected ${reason}, got ${describe(outcome)}`);
  const error = (outcome as Readonly<{ error: unknown }>).error;
  assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
  const details = error.details as Record<string, unknown>;
  assert.equal(details.reason ?? error.code, reason);
  if (expected.leaseId !== undefined) assert.equal(details.leaseId, expected.leaseId);
  if (expected.providerSessionId !== undefined) {
    assert.equal(details.providerSessionId, expected.providerSessionId);
  }
  if (expected.providerSessionIds !== undefined) {
    assert.deepEqual(details.providerSessionIds, expected.providerSessionIds);
  }
  if (expected.cleanup !== undefined) assert.equal(details.cleanup, expected.cleanup);
  if (expected.cleanupWarning !== undefined) {
    // A refusal for one session reports its warnings keyed by code, which loses nothing because one
    // session's warnings carry distinct codes; a shutdown reports every session it left billing as one
    // entry per warning. Either way the caller is told which refusal it got.
    const warnings = details.cleanupWarnings;
    const codes = Array.isArray(warnings)
      ? (warnings as Array<Record<string, unknown>>).map((warning) => warning.code)
      : Object.keys((warnings ?? {}) as Record<string, unknown>);
    assert.deepEqual(codes, [expected.cleanupWarning]);
  }
  if (expected.flags !== undefined) assert.deepEqual(details.flags, expected.flags);
}

function warningCodes(warnings: unknown): string[] {
  return ((warnings as Array<Record<string, unknown>> | undefined) ?? []).map((warning) =>
    String(warning.code),
  );
}

function warningMessages(warnings: unknown): unknown[] {
  return ((warnings as Array<Record<string, unknown>> | undefined) ?? []).map(
    (warning) => warning.message,
  );
}

function describe(outcome: Settled<unknown>): string {
  return outcome.status === 'rejected'
    ? `rejection: ${String(outcome.error)}`
    : `resolution: ${JSON.stringify(outcome.value)}`;
}

function makeRuntime(overrides: Partial<CloudWebDriverRuntimeOptions> = {}) {
  return createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'webdriver-test',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: 'Test device',
    profileFields: consumeAllProfileFields('webdriver-test'),
    requestPolicy: { retryAttempts: 0 },
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeLease(): DeviceLease {
  return {
    leaseId: 'lease-1',
    tenantId: 'team-a',
    runId: 'run-a',
    clientId: 'client-a',
    leaseProvider: 'webdriver-test',
    backend: 'android-instance',
    deviceKey: 'webdriver-test:device-a',
    createdAt: 1,
    expiresAt: 2,
    heartbeatAt: 1,
  };
}
