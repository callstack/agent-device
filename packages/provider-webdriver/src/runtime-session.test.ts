import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { deviceFieldsFromPublicPlatform, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverRuntime } from './runtime.ts';

test('session allocation preserves its primary failure when provider cleanup also fails', async () => {
  const previousFetch = globalThis.fetch;
  let cleanupCalled = false;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ value: { message: 'create session failed' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  const runtime = createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'webdriver-test',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: 'Test device',
    requestPolicy: { retryAttempts: 0 },
    prepareSession: async ({ base }) => ({
      ...base,
      cleanup: async () => {
        cleanupCalled = true;
        throw new Error('provider cleanup failed');
      },
    }),
  });

  try {
    const allocate = runtime.leaseLifecycle.allocate;
    assert.ok(allocate);
    await assert.rejects(
      () => allocate(makeLease()),
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
    globalThis.fetch = previousFetch;
  }
});

// #1774: a request already gone before the create is issued must create
// NOTHING. Prepared provider resources are cleaned up and no `POST /session`
// goes out, so there is no billed device session to leak.
test('allocation canceled before create issues no session and cleans up prepared work', async () => {
  const previousFetch = globalThis.fetch;
  let sessionRequests = 0;
  let cleanupCalled = false;
  globalThis.fetch = async (input) => {
    if (String(input instanceof Request ? input.url : input).endsWith('/session')) {
      sessionRequests += 1;
    }
    return new Response(JSON.stringify({ value: { sessionId: 'wd-1', capabilities: {} } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const runtime = createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'webdriver-test',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: 'Test device',
    requestPolicy: { retryAttempts: 0 },
    prepareSession: async ({ base }) => ({
      ...base,
      cleanup: async () => {
        cleanupCalled = true;
        return undefined;
      },
    }),
  });
  const controller = new AbortController();
  controller.abort();

  try {
    const allocate = runtime.leaseLifecycle.allocate;
    assert.ok(allocate);
    await assert.rejects(
      () => allocate(makeLease(), { signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'request_canceled');
        return true;
      },
    );
    assert.equal(sessionRequests, 0, 'no POST /session may be issued once canceled');
    assert.equal(cleanupCalled, true);
  } finally {
    await runtime.shutdown();
    globalThis.fetch = previousFetch;
  }
});

// #1774: the classic leak. The requester vanishes WHILE the provider is
// allocating; the create still completes server-side. The manager must not
// register that session (nobody is waiting on it) — it deletes it, holding the
// id it just learned, so the billed session is released instead of orphaned.
test('a session that completes after cancellation is released, not registered', async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  let deletedSessionId: string | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/session') && method === 'POST') {
      // The client disconnects mid-create; the provider finishes anyway.
      controller.abort();
      return new Response(JSON.stringify({ value: { sessionId: 'wd-live', capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/session/wd-live') && method === 'DELETE') {
      deletedSessionId = 'wd-live';
      return new Response(JSON.stringify({ value: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const runtime = createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'webdriver-test',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: 'Test device',
    requestPolicy: { retryAttempts: 0 },
  });
  const lease = makeLease();

  try {
    const allocate = runtime.leaseLifecycle.allocate;
    assert.ok(allocate);
    await assert.rejects(
      () => allocate(lease, { signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'request_canceled');
        assert.equal(error.details?.releasedWebDriverSessionId, 'wd-live');
        return true;
      },
    );
    assert.equal(deletedSessionId, 'wd-live', 'the completed session must be deleted');
    // Nothing registered: the device is not owned and no session answers for it.
    assert.equal(runtime.getInteractor(makeDevice(lease)), undefined);
  } finally {
    await runtime.shutdown();
    globalThis.fetch = previousFetch;
  }
});

// #1774: when the transport gives up on `POST /session`, the provider may still
// finish it. The error names the lease the capabilities were labelled with so
// an operator can find and stop the maybe-orphaned billed session, rather than
// this process guessing at REST cleanup of a session it never owned.
test('a create-timeout surfaces provider evidence for the maybe-leaked session', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input instanceof Request ? input.url : input).endsWith('/session')) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    }
    throw new Error('unexpected request');
  };
  const runtime = createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'browserstack',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'ios',
    deviceName: 'iPhone 17',
    requestPolicy: { retryAttempts: 0, sessionCreateTimeoutMs: 40 },
  });
  const lease = { ...makeLease(), leaseProvider: 'browserstack' };

  try {
    const allocate = runtime.leaseLifecycle.allocate;
    assert.ok(allocate);
    await assert.rejects(
      () => allocate(lease),
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
    globalThis.fetch = previousFetch;
  }
});

function makeDevice(lease: DeviceLease): DeviceInfo {
  return {
    ...deviceFieldsFromPublicPlatform('android'),
    id: `webdriver-test:android:${lease.leaseId}`,
    name: 'Test device',
    kind: 'device',
    target: 'mobile',
    booted: true,
  };
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
