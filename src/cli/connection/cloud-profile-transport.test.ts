// `connect cloud` sends its bearer token to the cloud profile endpoint only over https, or plain
// http to loopback.

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { connectCommand } from '../commands/connection.ts';
import { resolveCloudAccessForConnect } from '../auth-session.ts';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  beginStdoutCapture,
  bindTestCommandHost,
  closeLoopbackServer,
  listenOnLoopback,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

bindTestCommandHost();

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeLoopbackServer(server)));
});

/** A loopback cloud that records the `authorization` of each request it answers. */
async function serveCloud(answer: (res: http.ServerResponse) => void) {
  const received: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    received.push(req.headers.authorization);
    answer(res);
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${await listenOnLoopback(server)}`, received };
}

vi.mock('../auth-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth-session.ts')>()),
  resolveCloudAccessForConnect: vi.fn(),
}));

async function connectCloud(stateDir: string) {
  return await connectCommand({
    host: createTestHostEnvironment(),
    positionals: [],
    flags: { json: true, help: false, version: false, stateDir },
    client: {} as AgentDeviceClient,
  });
}

test('connect cloud never sends its bearer token to a plain http cloud off loopback', async () => {
  const stateDir = path.join(mkdtempForTestSync('agent-device-connect-cloud-transport-'), '.state');
  vi.mocked(resolveCloudAccessForConnect).mockResolvedValue({
    accessToken: 'adc_agent_cloud',
    cloudBaseUrl: 'http://cloud.example',
  });
  const send = vi.spyOn(globalThis, 'fetch');
  const stdoutCapture = beginStdoutCapture();

  try {
    await assert.rejects(
      async () => await connectCloud(stateDir),
      (error: unknown) => normalizeError(error).details?.reason === 'insecure_credential_transport',
    );
    assert.equal(send.mock.calls.length, 0);
  } finally {
    stdoutCapture.restore();
    send.mockRestore();
  }
});

test('a redirected profile request fails without reaching the other origin', async () => {
  const other = await serveCloud((res) => res.writeHead(401).end('{}'));
  const cloud = await serveCloud((res) =>
    res.writeHead(307, { location: `${other.origin}/profile` }).end(),
  );
  const stateDir = path.join(mkdtempForTestSync('agent-device-connect-cloud-redirect-'), '.state');
  vi.mocked(resolveCloudAccessForConnect).mockResolvedValue({
    accessToken: 'adc_agent_cloud',
    cloudBaseUrl: cloud.origin,
  });

  await assert.rejects(async () => await connectCloud(stateDir));

  assert.deepEqual(cloud.received, ['Bearer adc_agent_cloud']);
  assert.deepEqual(other.received, []);
});
