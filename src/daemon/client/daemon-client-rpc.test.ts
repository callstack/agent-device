import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { buildHttpRpcPayload, handleDaemonHttpResponseBody } from './daemon-client-rpc.ts';

test('lease allocation transports an optional initial provider app', () => {
  const payload = buildHttpRpcPayload(
    {
      token: 'daemon-token',
      session: 'qa-android',
      command: 'lease_allocate',
      positionals: [],
      flags: { providerApp: 'Example.apk' },
      meta: {
        requestId: 'lease-req',
        tenantId: 'acme',
        runId: 'run-123',
        leaseBackend: 'android-instance',
        leaseTtlMs: 30_000,
      },
    },
    { includeTokenParam: false },
  );

  assert.equal(payload.method, 'agent_device.lease.allocate');
  assert.deepEqual(payload.params, {
    session: 'qa-android',
    tenantId: 'acme',
    runId: 'run-123',
    ttlMs: 30_000,
    backend: 'android-instance',
    providerApp: 'Example.apk',
  });
});

test('HTTP RPC errors sanitize an untrusted cause before rehydration', () => {
  const secret = 'adc_agent_remote-secret';
  const oversizedCode = `apiKey=${secret} ${'c'.repeat(500)}`;
  const message =
    `download https://user:pass@example.test/app?token=${secret} failed: bearer ${secret} ` +
    'x'.repeat(500);
  let rejected: unknown;

  handleDaemonHttpResponseBody(
    JSON.stringify({
      error: {
        data: {
          code: 'COMMAND_FAILED',
          message: 'remote download failed',
          cause: { code: oversizedCode, message },
        },
      },
    }),
    {
      info: { token: 'daemon-token', pid: 1 },
      req: {
        command: 'apps_install_source',
        positionals: [],
        token: 'daemon-token',
        session: 'test-session',
      },
      stateDir: '/tmp/agent-device-test',
      resolve: () => undefined,
      reject: (error) => {
        rejected = error;
      },
    },
  );

  assert.ok(rejected instanceof AppError);
  const cause = rejected.cause as { code?: string; message: string } | undefined;
  assert.ok(cause);
  assert.equal(JSON.stringify(cause).includes(secret), false);
  assert.match(cause.message, /REDACTED/);
  assert.equal(cause.message.length, 400);
  assert.match(cause.message, /<truncated>$/);
  assert.match(cause.code ?? '', /^apiKey=\[REDACTED\]/);
  assert.equal(cause.code?.length, 400);
  assert.match(cause.code ?? '', /<truncated>$/);
});
