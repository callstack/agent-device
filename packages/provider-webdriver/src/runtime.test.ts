import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
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
