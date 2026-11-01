import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverRuntime, type CloudWebDriverRuntimeOptions } from './runtime.ts';
import { consumeAllProfileFields } from './profile-fields.fixtures.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * `POST /session` is billed and the lease is the only handle that can stop it again. Two allocations
 * that overlapped both passed the live-session check, so the second hub session overwrote the first
 * in the manager's map and only one of the two was ever releasable.
 */
test('two concurrent allocations of one lease create one billed session', async () => {
  const hub = startWebDriverHub();
  globalThis.fetch = hub.fetch;
  const provider = holdProviderPreparation();
  const runtime = makeRuntime({ prepareSession: provider.prepareSession });
  const lease = makeLease();

  try {
    const first = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await provider.waitForPreparation();
    const second = settle(() => runtime.leaseLifecycle.allocate!(lease));
    // One scheduler boundary while the first allocation is still held before the hub: the second has
    // then reached the lease, and the first cannot have published its session yet.
    await schedulerYield();
    provider.answerPreparation();

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    assert.equal(hub.createdSessionIds.length, 1, 'one lease bills one session');
    assertResolvedWith(firstOutcome, 'session-1');
    assertResolvedWith(secondOutcome, 'session-1');

    await runtime.leaseLifecycle.release!(lease);
    assert.deepEqual(hub.deletedSessionIds, hub.createdSessionIds);
    assert.equal(provider.cleanups, 1);
  } finally {
    provider.answerPreparation();
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
  globalThis.fetch = hub.fetch;
  const provider = holdProviderPreparation();
  const runtime = makeRuntime({ prepareSession: provider.prepareSession });
  const lease = makeLease();

  try {
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(lease));
    await provider.waitForPreparation();
    // The release takes the lease's entry in its first synchronous step, while the create is held.
    const releasing = settle(() => runtime.leaseLifecycle.release!(lease));
    provider.answerPreparation();

    assert.deepEqual(await releasing, {
      status: 'resolved',
      value: { provider: 'webdriver-test', providerSessionId: 'session-1' },
    });
    assert.deepEqual(hub.deletedSessionIds, ['session-1']);
    assert.equal(provider.cleanups, 1);
    assertRejectedWith(
      await allocating,
      'provider_session_released_during_allocation',
      lease.leaseId,
    );
  } finally {
    provider.answerPreparation();
    await runtime.shutdown();
  }
});

/** The same race on the route that ends every session this process holds. */
test('shutdown during creation disposes the session that creation makes', async () => {
  const hub = startWebDriverHub();
  globalThis.fetch = hub.fetch;
  const provider = holdProviderPreparation();
  const runtime = makeRuntime({ prepareSession: provider.prepareSession });

  try {
    const allocating = settle(() => runtime.leaseLifecycle.allocate!(makeLease()));
    await provider.waitForPreparation();
    // Shutdown takes every entry in its first synchronous step, while the create is held.
    const shuttingDown = settle(() => runtime.shutdown());
    provider.answerPreparation();

    assert.deepEqual(await shuttingDown, { status: 'resolved', value: undefined });
    assert.deepEqual(hub.deletedSessionIds, ['session-1']);
    assert.equal(provider.cleanups, 1);
    assertRejectedWith(await allocating, 'provider_session_shutdown_during_allocation');
  } finally {
    provider.answerPreparation();
    await runtime.shutdown();
  }
});

/**
 * The hub answers every WebDriver request and records the session ids it was asked to create and
 * delete, so a test's lever over an in-flight create is {@link holdProviderPreparation}.
 */
function startWebDriverHub() {
  const createdSessionIds: string[] = [];
  const deletedSessionIds: string[] = [];
  return {
    createdSessionIds,
    deletedSessionIds,
    fetch: (async (input: unknown, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.endsWith('/session')) {
        const sessionId = `session-${String(createdSessionIds.length + 1)}`;
        createdSessionIds.push(sessionId);
        return jsonResponse({ sessionId, capabilities: {} });
      }
      if (request.method === 'DELETE') {
        deletedSessionIds.push(decodeURIComponent(path.split('/').pop()!));
      }
      return jsonResponse({ value: null });
    }) as typeof fetch,
  };
}

/**
 * Holds `prepareSession` — the step that runs before this manager sends `POST /session` — until the
 * test answers it, so a create stays in flight across a release or a shutdown instead of the test
 * racing one with a sleep. It also counts the provider cleanup a prepared session owes, which is the
 * half of disposal the hub's `DELETE` does not cover.
 */
function holdProviderPreparation() {
  const state = { prepared: 0, cleanups: 0 };
  const arrivals: (() => void)[] = [];
  let settleGate: () => void = () => {};
  const gate = new Promise<void>((settle) => {
    settleGate = settle;
  });
  const prepareSession: NonNullable<CloudWebDriverRuntimeOptions['prepareSession']> = async ({
    base,
  }) => {
    state.prepared += 1;
    for (const arrived of arrivals.splice(0)) arrived();
    await gate;
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
    /** Resolves once an allocation has reached `prepareSession` and is held there. */
    waitForPreparation: async () => {
      while (state.prepared < 1) {
        await new Promise<void>((arrived) => {
          arrivals.push(arrived);
        });
      }
    },
    answerPreparation: () => {
      settleGate();
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
 * The typed reason an allocation reports when the session it made had already been taken to be
 * disposed, and the lease it was refused for.
 */
function assertRejectedWith(outcome: Settled<unknown>, reason: string, leaseId?: string): void {
  assert.equal(outcome.status, 'rejected', `expected ${reason}, got ${describe(outcome)}`);
  const error = (outcome as Readonly<{ error: unknown }>).error;
  assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
  assert.equal(error.details?.reason, reason);
  if (leaseId !== undefined) assert.equal(error.details?.leaseId, leaseId);
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
