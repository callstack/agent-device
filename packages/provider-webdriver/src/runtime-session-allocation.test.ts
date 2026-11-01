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
  options: Readonly<{ deleteFailure?: string; heldDeletes?: number }> = {},
) {
  const created: string[] = [];
  const deleted: string[] = [];
  let deletesToHold = options.heldDeletes ?? 0;
  let deleteFailure = options.deleteFailure;
  const held: (() => void)[] = [];
  return {
    created,
    deleted,
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
      }
      return jsonResponse({ value: null });
    }) as typeof fetch,
  };
}

type PrepareSession = NonNullable<CloudWebDriverRuntimeOptions['prepareSession']>;

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
    /** Resolves once `expected` allocations have reached the provider and are held there. */
    waitFor: async (expected: number) => {
      for (let attempt = 0; calls.length < expected && attempt < 200; attempt += 1) {
        await schedulerYield();
      }
      assert.ok(
        calls.length >= expected,
        `expected ${String(expected)} allocations to reach the provider, got ${String(calls.length)}`,
      );
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
): void {
  assert.equal(outcome.status, 'resolved', `expected ${sessionId}, got ${describe(outcome)}`);
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
    const warnings = details.cleanupWarnings as Record<string, unknown>;
    assert.deepEqual(Object.keys(warnings ?? {}), [expected.cleanupWarning]);
    assert.equal(typeof warnings[expected.cleanupWarning], 'string');
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
