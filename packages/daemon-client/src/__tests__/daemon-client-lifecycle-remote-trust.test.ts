// A remote daemon token over plain http off loopback is warned about from the settings the client
// reads, before the first request leaves.

import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test, vi } from 'vitest';
import { beginStderrCapture, createTestHostEnvironment } from '@agent-device/test-kit';
import { assertRemoteServesCheckedRpc } from '../index.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The stderr written by the time the first request to `daemonBaseUrl` opens; nothing is sent. */
async function stderrAtFirstSend(
  daemonBaseUrl: string,
  env: Record<string, string> = {},
): Promise<string> {
  const stderr = beginStderrCapture();
  let atSend: string | undefined;
  vi.spyOn(http, 'request').mockImplementation(() => {
    atSend ??= stderr.read();
    throw new Error('stop at the socket');
  });
  try {
    await assert.rejects(
      assertRemoteServesCheckedRpc(
        { daemonBaseUrl, daemonAuthToken: 'remote-secret' },
        createTestHostEnvironment({ env }),
      ),
    );
  } finally {
    stderr.restore();
  }
  assert.ok(atSend !== undefined, 'the client never reached the socket');
  return atSend;
}

test('a plain http daemon off loopback is warned about before the token leaves', async () => {
  const warning = await stderrAtFirstSend('http://warned.example.test:7777/agent-device');

  assert.match(warning, /http:\/\/warned\.example\.test:7777 are sent in cleartext/);
  assert.doesNotMatch(warning, /remote-secret|agent-device\/health/);
});

test.each([
  ['a loopback daemon', 'http://127.0.0.1:7777', {}],
  [
    'the override in the host environment',
    'http://overridden.example.test:7777',
    { AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT: '1' },
  ],
] as const)('%s is not warned about', async (_label, daemonBaseUrl, env) => {
  assert.equal(await stderrAtFirstSend(daemonBaseUrl, env), '');
});
