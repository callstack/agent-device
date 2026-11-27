// A remote daemon token never travels over plain http off loopback: the refusal comes from the
// settings the client reads, before any socket opens.

import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, test, vi } from 'vitest';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { createDaemonTransport } from '../index.ts';
import { resolveClientSettings } from '../daemon-client-lifecycle.ts';

const REQUEST = { session: 'default', command: 'devices', positionals: [], flags: {} };

afterEach(() => {
  vi.restoreAllMocks();
});

test('a token for a plain http daemon off loopback is refused before any request leaves', async () => {
  const opened = [
    vi.spyOn(http, 'request'),
    vi.spyOn(https, 'request'),
    vi.spyOn(net, 'connect'),
    vi.spyOn(net, 'createConnection'),
    vi.spyOn(globalThis, 'fetch'),
  ];
  const send = createDaemonTransport(
    createTestHostEnvironment({
      env: {
        AGENT_DEVICE_DAEMON_BASE_URL: 'http://remote-mac.example.test:7777/agent-device',
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'remote-secret',
      },
    }),
  );

  const refusal = await send(REQUEST).then(
    () => assert.fail('expected the plain http base URL to be refused'),
    (error: unknown) => error,
  );

  assert.ok(refusal instanceof AppError, String(refusal));
  assert.equal(refusal.code, 'INVALID_ARGS');
  assert.equal(refusal.details?.reason, 'insecure_credential_transport');
  assert.equal(refusal.details?.origin, 'http://remote-mac.example.test:7777');
  for (const spy of opened) assert.equal(spy.mock.calls.length, 0);
});

test.each([
  'http://127.0.0.1:4310/agent-device',
  'http://[::1]:4310/agent-device',
  'http://localhost:4310/agent-device',
  'https://remote-mac.example.test/agent-device',
])('a token for %s is admitted', (daemonBaseUrl) => {
  const settings = resolveClientSettings(
    { ...REQUEST, flags: { daemonBaseUrl } },
    'remote-secret',
    createTestHostEnvironment(),
  );
  assert.equal(settings.remoteBaseUrl, daemonBaseUrl);
  assert.equal(settings.remoteAuthToken, 'remote-secret');
});
