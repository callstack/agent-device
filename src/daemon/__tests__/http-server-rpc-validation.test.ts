import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createDaemonHttpServer } from '../server/http-server.ts';
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

// `DaemonRequest.internal` carries semantics-affecting bits stamped inside the
// daemon — `replayPlanStep` (#1271 stage 2) decides whether a read is an
// authored plan step or an out-of-band diagnostic, and so whether it lands in a
// repair heal. Two independent allowlists keep it unreachable from the wire:
// `commandRpcParamsSchema` projects only its eight named fields, and
// `toDaemonRequest` then builds the request field by field. Both would have to
// regress for a caller to stamp its own provenance; this pins the resulting
// boundary contract so neither drifts silently.
test('the rpc boundary never accepts internal request fields from the wire', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const received: DaemonRequest[] = [];
  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
    received.push(req);
    return { ok: true, data: { ok: true } };
  };
  const server = await createDaemonHttpServer({ handleRequest });

  try {
    const port = await listenOnLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'agent_device.command',
        params: {
          command: 'get',
          positionals: ['text', 'id=whatever'],
          internal: { replayPlanStep: true, replayTargetGuard: { ref: '@e1' } },
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    assert.equal(
      received[0]?.internal,
      undefined,
      'a wire-supplied `internal` must never reach the daemon request',
    );
  } finally {
    await closeLoopbackServer(server);
  }
});
