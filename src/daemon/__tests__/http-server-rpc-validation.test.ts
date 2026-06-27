import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createDaemonHttpServer } from '../http-server.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/index.ts';

type RpcErrorResponse = {
  jsonrpc: string;
  id: unknown;
  error?: { code: number; message: string; data?: { code?: string } };
  result?: unknown;
};

async function withCommandRpcServer(
  run: (
    postRpc: (params: unknown) => Promise<{ status: number; body: RpcErrorResponse }>,
  ) => Promise<void>,
  t: { skip(reason?: string): void },
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let handlerCalls = 0;
  const handleRequest = async (_req: DaemonRequest): Promise<DaemonResponse> => {
    handlerCalls += 1;
    return { ok: true, data: { ok: true } };
  };
  const server = await createDaemonHttpServer({ handleRequest });

  try {
    const port = await listenOnLoopback(server);
    const postRpc = async (params: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'agent_device.command',
          params,
        }),
      });
      return { status: response.status, body: (await response.json()) as RpcErrorResponse };
    };
    await run(postRpc);
    // The malformed-input cases below must be rejected at the boundary, never dispatched.
    assert.equal(handlerCalls, 0);
  } finally {
    await closeLoopbackServer(server);
  }
}

test('malformed command params (positionals as string) yield 400 / -32602, not 500 / -32000', async (t) => {
  await withCommandRpcServer(async (postRpc) => {
    const { status, body } = await postRpc({ command: 'devices', positionals: 'not-an-array' });

    assert.equal(status, 400);
    assert.equal(body.error?.code, -32602);
    assert.notEqual(body.error?.code, -32000);
    assert.equal(body.error?.data?.code, 'INVALID_ARGS');
    assert.ok(body.error?.message.startsWith('Invalid params:'), body.error?.message);
    // The internal schema path sigil must not leak onto the wire.
    assert.ok(!body.error?.message.includes('$.'), body.error?.message);
  }, t);
});

test('malformed command params (command as number) yield 400 / -32602', async (t) => {
  await withCommandRpcServer(async (postRpc) => {
    const { status, body } = await postRpc({ command: 42 });

    assert.equal(status, 400);
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error?.data?.code, 'INVALID_ARGS');
  }, t);
});
