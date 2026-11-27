// A remote daemon token never travels over plain http off loopback: the refusal comes from the
// settings the client reads, before any socket opens.

import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, test, vi } from 'vitest';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { assertRemoteServesCheckedRpc, createDaemonTransport } from '../index.ts';
import { resolveClientSettings } from '../daemon-client-lifecycle.ts';

const REQUEST = { session: 'default', command: 'devices', positionals: [], flags: {} };

afterEach(() => {
  vi.restoreAllMocks();
});

const INSECURE_BASE_URL = 'http://remote-mac.example.test:7777/agent-device';

function spyOnEverySend() {
  return [
    vi.spyOn(http, 'request'),
    vi.spyOn(https, 'request'),
    vi.spyOn(net, 'connect'),
    vi.spyOn(net, 'createConnection'),
    vi.spyOn(globalThis, 'fetch'),
  ];
}

async function refusalOf(task: () => Promise<unknown>): Promise<AppError> {
  const refusal = await task().then(
    () => assert.fail('expected the plain http base URL to be refused'),
    (error: unknown) => error,
  );
  assert.ok(refusal instanceof AppError, String(refusal));
  return refusal;
}

// The health-first route, and the checked route a connected profile opts into, both send the token
// to the same base URL; neither the probe nor the checked POST nor a recovery probe may start.
test.each([
  ['health-first', {}],
  ['checked', { daemonRpc: 'checked' }],
] as const)(
  'a token for a plain http daemon off loopback is refused on the %s route before any request leaves',
  async (_route, flags) => {
    const opened = spyOnEverySend();
    const send = createDaemonTransport(
      createTestHostEnvironment({
        env: {
          AGENT_DEVICE_DAEMON_BASE_URL: INSECURE_BASE_URL,
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'remote-secret',
        },
      }),
    );

    const refusal = await refusalOf(() => send({ ...REQUEST, flags }));

    assert.equal(refusal.code, 'INVALID_ARGS');
    assert.equal(refusal.details?.reason, 'insecure_credential_transport');
    assert.doesNotMatch(JSON.stringify([refusal.message, refusal.details]), /remote-mac/);
    for (const spy of opened) assert.equal(spy.mock.calls.length, 0);
  },
);

test('the connect checked-capability probe refuses a plain http daemon off loopback unsent', async () => {
  const opened = spyOnEverySend();

  const refusal = await refusalOf(() =>
    assertRemoteServesCheckedRpc(
      { daemonBaseUrl: INSECURE_BASE_URL, daemonAuthToken: 'remote-secret' },
      createTestHostEnvironment(),
    ),
  );

  assert.equal(refusal.details?.reason, 'insecure_credential_transport');
  assert.doesNotMatch(JSON.stringify([refusal.message, refusal.details]), /remote-mac/);
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
