import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createDaemonHttpServer } from './http-server.ts';
import {
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
} from '@agent-device/contracts/daemon-http';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';

type RpcErrorResponse = { error?: { code?: number; data?: { code?: string } } };

test('a stale RPC instance is refused after authentication and before command dispatch', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let handlerCalls = 0;
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async () => {
      handlerCalls += 1;
      return { ok: true, data: {} };
    },
  });
  try {
    const port = await listenOnLoopback(server);
    const endpoint = `http://127.0.0.1:${port}`;
    const health = (await (await fetch(`${endpoint}/health`)).json()) as { instanceId: string };
    const rpc = (expectedInstance: string, authToken = 'daemon-secret') =>
      fetch(`${endpoint}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${authToken}`,
          [DAEMON_HTTP_INSTANCE_HEADER]: expectedInstance,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'agent_device.command',
          params: { command: 'devices', positionals: [] },
        }),
      });
    const unauthorized = await rpc('previous-instance', 'wrong-token');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER), null);
    const unauthorizedBody = (await unauthorized.json()) as RpcErrorResponse;
    assert.equal(unauthorizedBody.error?.code, -32000);
    assert.equal(unauthorizedBody.error?.data?.code, 'UNAUTHORIZED');
    const stale = await rpc('previous-instance');
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER), 'true');
    const refused = (await stale.json()) as RpcErrorResponse;
    assert.equal(refused.error?.data?.code, 'COMMAND_FAILED');
    assert.equal(handlerCalls, 0);

    assert.equal((await rpc(health.instanceId)).status, 200);
    assert.equal(handlerCalls, 1);
  } finally {
    await closeLoopbackServer(server);
  }
});
