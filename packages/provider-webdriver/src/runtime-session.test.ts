import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverRuntime, type CloudWebDriverRuntimeOptions } from './runtime.ts';

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

function makeRuntime(overrides: Partial<CloudWebDriverRuntimeOptions> = {}) {
  return createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'webdriver-test',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: 'Test device',
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
