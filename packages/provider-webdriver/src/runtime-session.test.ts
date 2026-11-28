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

test('session allocation preserves its primary failure when provider cleanup also fails', async () => {
  let cleanupCalled = false;
  globalThis.fetch = async () => jsonResponse({ value: { message: 'create session failed' } }, 500);
  const runtime = makeRuntime({
    prepareSession: async ({ base }) => ({
      ...base,
      cleanup: async () => {
        cleanupCalled = true;
        throw new Error('provider cleanup failed');
      },
    }),
  });

  try {
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(makeLease()),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /create session failed/);
        assert.equal(error.details?.cleanupError, 'provider cleanup failed');
        return true;
      },
    );
    assert.equal(cleanupCalled, true);
  } finally {
    await runtime.shutdown();
  }
});

// #1774: when the transport gives up on `POST /session`, the provider may still
// finish it. The error names the lease the capabilities were labelled with so
// an operator can find and stop the maybe-orphaned billed session, rather than
// this process guessing at REST cleanup of a session it never owned.
test('a create-timeout surfaces provider evidence for the maybe-leaked session', async () => {
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });
  const runtime = makeRuntime({
    provider: 'browserstack',
    platform: 'ios',
    requestPolicy: { retryAttempts: 0, sessionCreateTimeoutMs: 40 },
  });
  const lease = { ...makeLease(), leaseProvider: 'browserstack' };

  try {
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(lease),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'provider_session_create_timeout');
        assert.equal(error.details?.provider, 'browserstack');
        assert.equal(error.details?.leaseId, lease.leaseId);
        assert.match(String(error.details?.hint), new RegExp(lease.leaseId));
        return true;
      },
    );
  } finally {
    await runtime.shutdown();
  }
});

/**
 * `DELETE /session/{id}` is idempotent: one transient hub failure is retried rather than left as a
 * billed session, and a hub that no longer knows the session (`invalid session id`) has ended it.
 */
test.each([
  ['a transient delete failure is retried', 502, '<html>Bad Gateway</html>'],
  [
    'a delete answered invalid session id',
    404,
    JSON.stringify({ value: { error: 'invalid session id', message: 'session not found' } }),
  ],
] as const)('%s confirms the release', async (_name, status, body) => {
  const deletes: number[] = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? new Request(input as RequestInfo).method;
    if (method !== 'DELETE') return jsonResponse({ sessionId: 'session-1', capabilities: {} });
    deletes.push(deletes.length);
    return deletes.length === 1 ? new Response(body, { status }) : jsonResponse({ value: null });
  };
  const runtime = makeRuntime({ requestPolicy: { retryAttempts: 1, retryDelayMs: 1 } });
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    assert.deepEqual(await runtime.leaseLifecycle.release!(lease), {
      provider: 'webdriver-test',
      providerSessionId: 'session-1',
    });
  } finally {
    await runtime.shutdown();
  }
});

test('cloud artifact lookup does not accept a provider session id without its lease', async () => {
  let listCalls = 0;
  const runtime = makeRuntime({
    listArtifacts: async () => {
      listCalls += 1;
      return {
        provider: 'webdriver-test',
        status: 'ready',
        cloudArtifacts: [],
      };
    },
  });

  try {
    const cloudArtifacts = runtime.cloudArtifacts;
    assert.ok(cloudArtifacts);
    const result = await cloudArtifacts.listCloudArtifacts?.({
      provider: 'webdriver-test',
      providerSessionId: 'never-authorized',
    });
    assert.equal(result, undefined);
    assert.equal(listCalls, 0);
  } finally {
    await runtime.shutdown();
  }
});

/** A hub that rents `session-1`, reports `capabilities`, and records each request method. */
function stubHub(capabilities: Record<string, unknown>): string[] {
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? new Request(input as RequestInfo).method;
    methods.push(method);
    return method === 'DELETE'
      ? jsonResponse({ value: null })
      : jsonResponse({ sessionId: 'session-1', capabilities });
  };
  return methods;
}

// A hub whose job lives in a per-session data center binds its lookup at preparation; the lookup
// after release must still reach that data center, with the inputs the active path passes.
test('a released lease lists artifacts through its prepared lookup, under the provider job id', async () => {
  stubHub({ jobUuid: 'job-1' });
  const lookups: unknown[] = [];
  const runtime = makeRuntime({
    listArtifacts: async ({ provider }) => {
      lookups.push('runtime');
      return { provider, status: 'ready', cloudArtifacts: [] };
    },
    prepareSession: async ({ base }) => ({
      ...base,
      describeCreatedSession: (capabilities) => ({
        providerSessionId: String(capabilities.jobUuid),
      }),
      listArtifacts: async ({ provider, providerSessionId, webDriverSessionId }) => {
        lookups.push({ providerSessionId, webDriverSessionId });
        return { provider, providerSessionId, status: 'ready', cloudArtifacts: [] };
      },
    }),
  });
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    const released = await runtime.leaseLifecycle.release!(lease);
    assert.equal(released?.providerSessionId, 'job-1');
    lookups.length = 0;
    const result = await runtime.cloudArtifacts?.listCloudArtifacts?.({
      provider: 'webdriver-test',
      leaseId: lease.leaseId,
    });
    assert.equal(result?.providerSessionId, 'job-1');
    assert.deepEqual(lookups, [{ providerSessionId: 'job-1', webDriverSessionId: 'session-1' }]);
  } finally {
    await runtime.shutdown();
  }
});

// BrowserStack and AWS Device Farm bind no per-session lookup; theirs stays the runtime-wide one.
test('a released lease without a prepared lookup lists artifacts through the runtime lookup', async () => {
  stubHub({});
  const lookups: unknown[] = [];
  const runtime = makeRuntime({
    listArtifacts: async ({ provider, providerSessionId }) => {
      lookups.push(providerSessionId);
      return { provider, providerSessionId, status: 'ready', cloudArtifacts: [] };
    },
  });
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    await runtime.leaseLifecycle.release!(lease);
    lookups.length = 0;
    const result = await runtime.cloudArtifacts?.listCloudArtifacts?.({
      provider: 'webdriver-test',
      leaseId: lease.leaseId,
    });
    assert.equal(result?.providerSessionId, 'session-1');
    assert.deepEqual(lookups, ['session-1']);
  } finally {
    await runtime.shutdown();
  }
});

test('the created session reports the allocated model under the requested name, and an empty provider id falls back', async () => {
  stubHub({ platformVersion: '15' });
  const runtime = makeRuntime({
    prepareSession: async ({ base }) => ({
      ...base,
      deviceName: 'Pixel.*',
      describeCreatedSession: () => ({ providerSessionId: ' ', model: 'Pixel 8 (Pixel_8_15)' }),
    }),
  });
  const lease = makeLease();

  try {
    const allocated = await runtime.leaseLifecycle.allocate!(lease);
    assert.equal(allocated?.providerSessionId, 'session-1');
    const [device] =
      (await runtime.deviceInventoryProvider({
        leaseProvider: 'webdriver-test',
        leaseId: lease.leaseId,
      } as never)) ?? [];
    // Commands select the device by the name they asked for, so the name stays the selector.
    assert.equal(device?.name, 'Pixel.*');
    assert.equal(device?.model, 'Pixel 8 (Pixel_8_15)');
    assert.equal(device?.osVersion, '15');
  } finally {
    await runtime.shutdown();
  }
});

// The hub already rented the session when the provider fails to read it, so the allocation itself must
// end it; no entry ever holds it for a release or a shutdown to find.
test('a failure after the hub created the session deletes it, runs cleanup, and keeps the error', async () => {
  const methods = stubHub({});
  let cleanups = 0;
  const runtime = makeRuntime({
    prepareSession: async ({ base }) => ({
      ...base,
      describeCreatedSession: () => {
        throw new AppError('COMMAND_FAILED', 'unreadable create answer');
      },
      cleanup: async () => {
        cleanups += 1;
        return undefined;
      },
    }),
  });

  try {
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(makeLease()),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.message, 'unreadable create answer');
        assert.equal(error.details?.cleanupError, undefined);
        return true;
      },
    );
    assert.deepEqual(methods, ['POST', 'DELETE']);
    assert.equal(cleanups, 1);
  } finally {
    await runtime.shutdown();
  }
});

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
